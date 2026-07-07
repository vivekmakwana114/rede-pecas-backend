import { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { logger } from '../config/logger.js';
import { importProductsBatch, getOrCreateSupplierByName, ImportItem } from '../models/supplier.model.js';
import { notifyWaitlistedCustomers } from '../services/product.service.js';

/**
 * Bulk imports spreadsheet rows mapped to supplier items. `supplierId` is the
 * fallback for any item that doesn't carry its own supplierId — a single
 * request can mix products from several suppliers by setting it per item.
 */
export async function importProductsBatchHandler(req: Request, res: Response): Promise<void> {
  const { supplierId, items } = req.body;

  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'Invalid parameters. items is required.' });
    return;
  }

  try {
    const result = await importProductsBatch(items, supplierId ? Number(supplierId) : null);
    await notifyWaitlistedCustomers(result.restockNotifications);
    res.json(result);
  } catch (error: any) {
    logger.error('Error importing batch products', error);
    res.status(500).json({ error: error.message });
  }
}

const HEADER_ALIASES: Record<string, string[]> = {
  reference: ['reference', 'referencia', 'ref', 'sku'],
  name: ['name', 'nome', 'descricao', 'description', 'descrição'],
  price: ['price', 'preco', 'preço'],
  quantity: ['quantity', 'quantidade', 'qty', 'stock'],
  supplierName: ['supplier', 'supplier_name', 'fornecedor', 'nome_fornecedor'],
  supplierNif: ['supplier_nif', 'nif_fornecedor'],
  supplierProvince: ['supplier_province', 'provincia_fornecedor'],
};

/**
 * Maps one spreadsheet row to an import item. Supplier columns are optional —
 * a row without them falls back to the request-level default supplier
 * (importProductsBatch handles that fallback), so a single-supplier file
 * doesn't need to repeat the supplier on every row.
 */
function normalizeRow(row: Record<string, any>): ImportItem | null {
  const lowerRow = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const pick = (field: string) => {
    for (const alias of HEADER_ALIASES[field]) {
      if (lowerRow[alias] !== undefined && lowerRow[alias] !== '') return lowerRow[alias];
    }
    return undefined;
  };
  const reference = pick('reference');
  const name = pick('name');
  const price = Number(pick('price'));
  const quantity = Number(pick('quantity'));
  if (!reference || !name || Number.isNaN(price) || Number.isNaN(quantity)) return null;

  const supplierName = pick('supplierName');

  return {
    reference: String(reference),
    name: String(name),
    price,
    quantity,
    supplierName: supplierName ? String(supplierName) : undefined,
    supplierNif: pick('supplierNif') ? String(pick('supplierNif')) : undefined,
    supplierProvince: pick('supplierProvince') ? String(pick('supplierProvince')) : undefined,
  };
}

/**
 * Bulk imports products from an uploaded CSV/XLSX file, parsed server-side.
 * The supplier can be given once for the whole file (existing supplierId, or
 * supplierName/nif/province to create one on the fly) and/or per row via
 * supplier/supplier_nif/supplier_province columns — rows without their own
 * supplier columns fall back to the request-level one. A file can therefore
 * mix products from several different suppliers in one upload.
 */
export async function importProductsFileHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ error: 'File is required (field name: file).' });
    return;
  }

  const { supplierId, supplierName, supplierNif, supplierProvince } = req.body;

  try {
    let defaultSupplierId: number | null = null;
    if (supplierId) {
      defaultSupplierId = Number(supplierId);
    } else if (supplierName) {
      defaultSupplierId = await getOrCreateSupplierByName(supplierName, supplierNif, supplierProvince);
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);

    const items = rawRows
      .map(normalizeRow)
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (!items.length) {
      res.status(400).json({ error: 'No valid rows found in the file (check column headers).' });
      return;
    }

    const result = await importProductsBatch(items, defaultSupplierId);
    await notifyWaitlistedCustomers(result.restockNotifications);

    res.json(result);
  } catch (error: any) {
    logger.error('Error importing inventory file', error);
    res.status(500).json({ error: error.message });
  }
}

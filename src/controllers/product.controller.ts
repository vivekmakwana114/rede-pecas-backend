import { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import { importProductsBatch, getOrCreateSupplierByName, ImportItem } from '../models/supplier.model.js';
import { notifyWaitlistedCustomers } from '../services/product.service.js';

/**
 * Bulk imports spreadsheet rows mapped to supplier items. `supplierId` is the
 * fallback for any item that doesn't carry its own supplierId — a single
 * request can mix products from several suppliers by setting it per item.
 */
export const importProductsBatchHandler = catchAsync(async (req: Request, res: Response) => {
  const { supplierId, items } = req.body;

  if (!Array.isArray(items)) {
    throw new ApiError(400, 'Invalid parameters. items is required.');
  }

  const result = await importProductsBatch(items, supplierId ? Number(supplierId) : null);
  await notifyWaitlistedCustomers(result.restockNotifications);

  res.status(200).json({
    success: true,
    message: 'Products imported.',
    code: 200,
    data: result,
    meta: { timestamp: new Date().toISOString() },
  });
});

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
export const importProductsFileHandler = catchAsync(async (req: Request, res: Response) => {
  if (!req.file) {
    throw new ApiError(400, 'File is required (field name: file).');
  }

  const { supplierId, supplierName, supplierNif, supplierProvince } = req.body;

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
    throw new ApiError(400, 'No valid rows found in the file (check column headers).');
  }

  const result = await importProductsBatch(items, defaultSupplierId);
  await notifyWaitlistedCustomers(result.restockNotifications);

  res.status(200).json({
    success: true,
    message: 'Inventory file imported.',
    code: 200,
    data: result,
    meta: { timestamp: new Date().toISOString() },
  });
});

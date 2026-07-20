import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import * as productService from '../services/product.service.js';
import { getAllActiveProducts, getProductById, updateProduct, deactivateProduct, Product } from '../models/product.model.js';
import { resolveSupplierForProductEdit } from '../models/supplier.model.js';

/**
 * Lists every active product (joined with its supplier) for the admin
 * panel's inventory grid — unfiltered, unpaginated, matching the current
 * catalog size (low hundreds of rows). Revisit with pagination/filtering if
 * the catalog grows enough to make that a problem.
 */
export const getProductsHandler = catchAsync(async (req: Request, res: Response) => {
  const products = await getAllActiveProducts();

  res.status(200).json({
    success: true,
    message: 'Products retrieved.',
    code: 200,
    data: products,
    meta: { timestamp: new Date().toISOString() },
  });
});

export const getProductHandler = catchAsync(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const product = await getProductById(id);
  if (!product) throw new ApiError(404, `Product ${id} not found`);

  res.status(200).json({
    success: true,
    message: 'Product retrieved.',
    code: 200,
    data: product,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Admin edits to a product's catalog/stock fields, plus its supplier's
 * contact/display fields (name, address, phone). Editing this product's
 * supplier fields never mutates the supplier row it currently points to —
 * that row is shared by every other product from the same supplier. Instead
 * it resolves (via resolveSupplierForProductEdit) which supplier row this
 * product *should* point to given the submitted name/address/phone, and only
 * repoints this one product's supplier_id — every other product stays on
 * whatever it already pointed to. There's no dedicated supplier management
 * screen yet, so this panel doubles as it.
 */
export const updateProductHandler = catchAsync(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await getProductById(id);
  if (!existing) throw new ApiError(404, `Product ${id} not found`);

  const {
    name,
    reference,
    price,
    quantity,
    delivery_time,
    service_offered,
    service_name,
    service_price,
    supplierName,
    supplierAddress,
    supplierPhone,
  } = req.body;
  const fields: Partial<Product> = {};
  if (name !== undefined) fields.name = name;
  if (reference !== undefined) fields.reference = reference;
  if (price !== undefined) fields.price = price;
  if (quantity !== undefined) fields.quantity = quantity;
  if (delivery_time !== undefined) fields.delivery_time = delivery_time;
  if (service_offered !== undefined) fields.service_offered = service_offered;
  if (service_name !== undefined) fields.service_name = service_name;
  if (service_price !== undefined) fields.service_price = service_price;

  if (existing.supplier_id && (supplierName !== undefined || supplierAddress !== undefined || supplierPhone !== undefined)) {
    const targetName = supplierName !== undefined ? supplierName : existing.supplier;
    const targetAddress = supplierAddress !== undefined ? supplierAddress : existing.supplier_address ?? null;
    const targetPhone = supplierPhone !== undefined ? supplierPhone : existing.supplier_phone ?? null;

    const supplierChanged =
      targetName !== existing.supplier ||
      (targetAddress || null) !== (existing.supplier_address || null) ||
      (targetPhone || null) !== (existing.supplier_phone || null);

    if (supplierChanged && targetName) {
      fields.supplier_id = await resolveSupplierForProductEdit(targetName, targetAddress, targetPhone, existing.supplier_id);
    }
  }

  await updateProduct(id, fields);
  const updated = await getProductById(id);

  res.status(200).json({
    success: true,
    message: `Product ${id} updated.`,
    code: 200,
    data: updated,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Soft-deletes the product (active = false) — see deactivateProduct for why
 * this isn't a hard DELETE.
 */
export const deleteProductHandler = catchAsync(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const deleted = await deactivateProduct(id);
  if (!deleted) throw new ApiError(404, `Product ${id} not found`);

  res.status(200).json({
    success: true,
    message: `Product ${id} deleted.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

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

  const result = await productService.importInventoryBatch(items, supplierId ? Number(supplierId) : null);

  res.status(200).json({
    success: true,
    message: 'Products imported.',
    code: 200,
    data: result,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Bulk imports products from a single uploaded CSV/XLSX file, parsed
 * server-side. Reference, Name, Price, Quantity and Supplier are required
 * columns (per row a supplier name — no request-level fallback), and a row
 * with Service = yes must also carry a valid Service Price. Validation runs
 * in full before anything is written: a missing column rejects the file with
 * the list of missing column names, and any row-level problem (bad/missing
 * price, quantity, supplier, or service price) rejects the whole file with
 * every problem listed — nothing is imported until the file is entirely
 * clean, so the admin fixes it once and re-uploads rather than getting a
 * silent partial import.
 */
export const importProductsFileHandler = catchAsync(async (req: Request, res: Response) => {
  if (!req.file) {
    throw new ApiError(400, 'File is required (field name: file).');
  }

  const result = await productService.importInventoryFromFile(req.file.buffer);

  res.status(200).json({
    success: true,
    message: 'Inventory file imported.',
    code: 200,
    data: result,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Streams a blank XLSX with just the columns importInventoryFromFile expects
 * — binary response, not the standard JSON envelope (same exception as the
 * payment-proof download route).
 */
export const downloadInventoryTemplateHandler = catchAsync(async (req: Request, res: Response) => {
  const file = productService.generateInventoryTemplateFile();

  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory-template.xlsx"');
  res.send(file);
});

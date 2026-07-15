import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import * as productService from '../services/product.service.js';
import { getAllActiveProducts } from '../models/product.model.js';

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

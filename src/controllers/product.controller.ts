import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import * as productService from '../services/product.service.js';

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
  const result = await productService.importInventoryFromFile(req.file.buffer, {
    supplierId,
    supplierName,
    supplierNif,
    supplierProvince,
  });

  res.status(200).json({
    success: true,
    message: 'Inventory file imported.',
    code: 200,
    data: result,
    meta: { timestamp: new Date().toISOString() },
  });
});

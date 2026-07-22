import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import * as productService from '../services/product.service.js';
import { getAllProducts, getProductByIdAnyStatus, updateProduct, hardDeleteProduct, Product } from '../models/product.model.js';
import { resolveSupplierForProductEdit } from '../models/supplier.model.js';
import { SUBCATEGORY_TO_SERVICE_CATEGORY } from '../constants/serviceCategory.js';

/**
 * Lists every product, active and inactive (joined with its supplier), for
 * the admin panel's inventory grid — unfiltered, unpaginated, matching the
 * current catalog size (low hundreds of rows). Revisit with
 * pagination/filtering if the catalog grows enough to make that a problem.
 * Inactive products stay listed (with an `active: false` flag for the UI to
 * badge/toggle) rather than disappearing, so deactivating one is reversible
 * from the grid instead of a dead end.
 */
export const getProductsHandler = catchAsync(async (req: Request, res: Response) => {
  const products = await getAllProducts();

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
  const product = await getProductByIdAnyStatus(id);
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
  const existing = await getProductByIdAnyStatus(id);
  if (!existing) throw new ApiError(404, `Product ${id} not found`);

  const {
    name,
    reference,
    price,
    quantity,
    active,
    category,
    subcategory,
    vehicle_make,
    vehicle_model,
    year_start,
    year_end,
    engine,
    delivery_time,
    oem_reference,
    brand,
    engine_number,
    viscosity,
    engine_type,
    volume_liters,
    specification,
    interval_km,
    image_url,
    synonyms,
    description,
    supplierName,
    supplierAddress,
    supplierPhone,
  } = req.body;
  const fields: Partial<Product> = {};
  if (name !== undefined) fields.name = name;
  if (reference !== undefined) fields.reference = reference;
  if (price !== undefined) fields.price = price;
  if (quantity !== undefined) fields.quantity = quantity;
  if (active !== undefined) fields.active = active;
  if (category !== undefined) fields.category = category;
  if (subcategory !== undefined) {
    // service_category is never client-settable directly — it's always
    // recomputed from subcategory via the shared mapping, so the two columns
    // (and the products/services matching join built on service_category)
    // never drift out of sync.
    const mapped = SUBCATEGORY_TO_SERVICE_CATEGORY[subcategory];
    if (!mapped) throw new ApiError(400, `Unknown subcategory "${subcategory}" — no service_category mapping exists for it.`);
    fields.subcategory = subcategory;
    fields.service_category = mapped;
  }
  if (vehicle_make !== undefined) fields.vehicle_make = vehicle_make;
  if (vehicle_model !== undefined) fields.vehicle_model = vehicle_model;
  if (year_start !== undefined) fields.year_start = year_start;
  if (year_end !== undefined) fields.year_end = year_end;
  if (engine !== undefined) fields.engine = engine;
  if (delivery_time !== undefined) fields.delivery_time = delivery_time;
  if (oem_reference !== undefined) fields.oem_reference = oem_reference;
  if (brand !== undefined) fields.brand = brand;
  if (engine_number !== undefined) fields.engine_number = engine_number;
  if (viscosity !== undefined) fields.viscosity = viscosity;
  if (engine_type !== undefined) fields.engine_type = engine_type;
  if (volume_liters !== undefined) fields.volume_liters = volume_liters;
  if (specification !== undefined) fields.specification = specification;
  if (interval_km !== undefined) fields.interval_km = interval_km;
  if (image_url !== undefined) fields.image_url = image_url;
  if (synonyms !== undefined) fields.synonyms = synonyms;
  if (description !== undefined) fields.description = description;

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
  const updated = await getProductByIdAnyStatus(id);

  res.status(200).json({
    success: true,
    message: `Product ${id} updated.`,
    code: 200,
    data: updated,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Permanently deletes the product — only allowed once it's already inactive
 * (deactivate it first via PATCH /admin/products/:id { active: false }; see
 * updateProductHandler above). A product still referenced by an existing
 * order or waitlist_requests row (both have a plain FK into products, no
 * cascade) can't be deleted at all — Postgres rejects the DELETE with a
 * foreign-key-violation (23503), caught here and turned into a clear 409
 * instead of a raw 500.
 */
export const deleteProductHandler = catchAsync(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  let result;
  try {
    result = await hardDeleteProduct(id);
  } catch (error: any) {
    if (error?.code === '23503') {
      throw new ApiError(409, `Product ${id} can't be deleted — it's still referenced by existing orders or waitlist requests.`);
    }
    throw error;
  }

  if (result === 'not_found') throw new ApiError(404, `Product ${id} not found`);
  if (result === 'still_active') {
    throw new ApiError(409, `Product ${id} is still active — deactivate it first before deleting.`);
  }

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

  // serviceCategory is derived server-side from subcategory (never accepted
  // from the client — see importItemSchema/updateProductHandler) so it can
  // never drift from the shared SUBCATEGORY_TO_SERVICE_CATEGORY mapping.
  const itemsWithServiceCategory = items.map((item: any) => {
    const serviceCategory = SUBCATEGORY_TO_SERVICE_CATEGORY[item.subcategory];
    if (!serviceCategory) {
      throw new ApiError(400, `Unknown subcategory "${item.subcategory}" — no service_category mapping exists for it.`);
    }
    return { ...item, serviceCategory };
  });

  const result = await productService.importInventoryBatch(itemsWithServiceCategory, supplierId ? Number(supplierId) : null);

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
 * server-side. A column missing entirely from the header row rejects the
 * whole file (structural problem, named in the error). A row-level problem
 * (bad/missing price, description, unknown subcategory, etc.) does NOT
 * reject the file — that row is skipped and reported back in
 * `data.skipped`, while every other valid row still imports.
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

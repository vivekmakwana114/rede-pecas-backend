import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import * as serviceService from '../services/service.service.js';
import {
  getAllServices,
  getServiceById,
  updateService,
  hardDeleteService,
  importServicesBatch,
  resolveServiceProviderForEdit,
  Service,
} from '../models/service.model.js';

/**
 * Lists every service, active and inactive (joined with its provider), for
 * the admin panel's services grid — mirrors getProductsHandler. Inactive
 * services stay listed so deactivating one is reversible from the grid.
 */
export const getServicesHandler = catchAsync(async (req: Request, res: Response) => {
  const services = await getAllServices();

  res.status(200).json({
    success: true,
    message: 'Services retrieved.',
    code: 200,
    data: services,
    meta: { timestamp: new Date().toISOString() },
  });
});

export const getServiceHandler = catchAsync(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const service = await getServiceById(id);
  if (!service) throw new ApiError(404, `Service ${id} not found`);

  res.status(200).json({
    success: true,
    message: 'Service retrieved.',
    code: 200,
    data: service,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Admin edits to a service's own fields, plus its provider's contact/display
 * fields (name, address, province, phone) — mirrors updateProductHandler's
 * supplier-repoint pattern via resolveServiceProviderForEdit.
 */
export const updateServiceHandler = catchAsync(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await getServiceById(id);
  if (!existing) throw new ApiError(404, `Service ${id} not found`);

  const {
    service_name,
    service_category,
    service_base_price,
    service_duration_h,
    available_at_home,
    base_travel_fee,
    logistics_fee_notes,
    active,
    providerName,
    providerAddress,
    providerProvince,
    providerPhone,
  } = req.body;
  const fields: Partial<Service> = {};
  if (service_name !== undefined) fields.service_name = service_name;
  if (service_category !== undefined) fields.service_category = service_category;
  if (service_base_price !== undefined) fields.service_base_price = service_base_price;
  if (service_duration_h !== undefined) fields.service_duration_h = service_duration_h;
  if (available_at_home !== undefined) fields.available_at_home = available_at_home;
  if (base_travel_fee !== undefined) fields.base_travel_fee = base_travel_fee;
  if (logistics_fee_notes !== undefined) fields.logistics_fee_notes = logistics_fee_notes;
  if (active !== undefined) fields.active = active;

  if (
    existing.provider_id &&
    (providerName !== undefined || providerAddress !== undefined || providerProvince !== undefined || providerPhone !== undefined)
  ) {
    const targetName = providerName !== undefined ? providerName : existing.provider_name;
    const targetProvince = providerProvince !== undefined ? providerProvince : existing.provider_province ?? null;
    const targetPhone = providerPhone !== undefined ? providerPhone : existing.provider_phone ?? null;

    if (targetName) {
      fields.provider_id = await resolveServiceProviderForEdit(
        targetName,
        providerAddress ?? null,
        targetProvince,
        targetPhone,
        existing.provider_id
      );
    }
  }

  await updateService(id, fields);
  const updated = await getServiceById(id);

  res.status(200).json({
    success: true,
    message: `Service ${id} updated.`,
    code: 200,
    data: updated,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Permanently deletes the service — mirrors deleteProductHandler: only
 * allowed once it's already inactive (deactivate first via PATCH
 * /admin/services/:id { active: false }).
 */
export const deleteServiceHandler = catchAsync(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await hardDeleteService(id);

  if (result === 'not_found') throw new ApiError(404, `Service ${id} not found`);
  if (result === 'still_active') {
    throw new ApiError(409, `Service ${id} is still active — deactivate it first before deleting.`);
  }

  res.status(200).json({
    success: true,
    message: `Service ${id} deleted.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Bulk imports spreadsheet rows mapped to provider items — mirrors
 * importProductsBatchHandler.
 */
export const importServicesBatchHandler = catchAsync(async (req: Request, res: Response) => {
  const { providerId, items } = req.body;

  if (!Array.isArray(items)) {
    throw new ApiError(400, 'Invalid parameters. items is required.');
  }

  const result = await importServicesBatch(items, providerId ? Number(providerId) : null);

  res.status(200).json({
    success: true,
    message: 'Services imported.',
    code: 200,
    data: result,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Bulk imports services from a single uploaded CSV/XLSX file — mirrors
 * importProductsFileHandler. A row-level problem is skipped and reported in
 * `data.skipped` rather than rejecting the whole file.
 */
export const importServicesFileHandler = catchAsync(async (req: Request, res: Response) => {
  if (!req.file) {
    throw new ApiError(400, 'File is required (field name: file).');
  }

  const result = await serviceService.importServicesFromFile(req.file.buffer);

  res.status(200).json({
    success: true,
    message: 'Services file imported.',
    code: 200,
    data: result,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Streams a blank XLSX with just the columns importServicesFromFile expects
 * — mirrors downloadInventoryTemplateHandler.
 */
export const downloadServicesTemplateHandler = catchAsync(async (req: Request, res: Response) => {
  const file = serviceService.generateServicesTemplateFile();

  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="services-template.xlsx"');
  res.send(file);
});

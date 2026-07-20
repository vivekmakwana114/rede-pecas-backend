import Joi from 'joi';
import { ValidationSchema } from '../middlewares/validate.js';

export const orderListQuery: ValidationSchema = {
  query: Joi.object().keys({
    range: Joi.string().valid('today', 'all').default('all'),
  }),
};

export const orderReview: ValidationSchema = {
  params: Joi.object().keys({
    number: Joi.string().required(),
  }),
  body: Joi.object().keys({
    approved: Joi.boolean().required(),
  }),
};

export const orderStockConfirmation: ValidationSchema = {
  params: Joi.object().keys({
    number: Joi.string().required(),
  }),
  body: Joi.object().keys({
    available: Joi.boolean().required(),
  }),
};

export const orderAnalyticsQuery: ValidationSchema = {
  query: Joi.object().keys({
    period: Joi.string().valid('daily', 'monthly', 'yearly').required(),
  }),
};

export const orderNumberParams: ValidationSchema = {
  params: Joi.object().keys({
    number: Joi.string().required(),
  }),
};

export const alertParams: ValidationSchema = {
  params: Joi.object().keys({
    id: Joi.number().integer().required(),
  }),
};

export const customerListQuery: ValidationSchema = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(200),
    q: Joi.string().allow(''),
  }),
};

export const customerPhoneParams: ValidationSchema = {
  params: Joi.object().keys({
    phone: Joi.string().required(),
  }),
};

export const customerUpdate: ValidationSchema = {
  params: Joi.object().keys({
    phone: Joi.string().required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string(),
      nif: Joi.string().allow('', null),
      address: Joi.string().allow('', null),
      email: Joi.string().email().allow('', null),
    })
    .min(1),
};

export const productIdParams: ValidationSchema = {
  params: Joi.object().keys({
    id: Joi.number().integer().required(),
  }),
};

export const productUpdate: ValidationSchema = {
  params: Joi.object().keys({
    id: Joi.number().integer().required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string(),
      reference: Joi.string(),
      price: Joi.number(),
      quantity: Joi.number().integer().min(0),
      service_offered: Joi.boolean(),
      service_name: Joi.string().allow('', null),
      service_price: Joi.number().allow(null),
      // Supplier's own fields — edited from a product's own panel since
      // there's no dedicated supplier management screen yet (see
      // resolveSupplierForProductEdit in supplier.model.ts).
      supplierName: Joi.string(),
      supplierAddress: Joi.string().allow('', null),
      supplierPhone: Joi.string().allow('', null),
    })
    .min(1),
};

// Mirrors validateRow's row-level rules in product.service.ts (the
// file-upload import path) so both entry points into importProductsBatch
// reject the same bad data — serviceName/servicePrice only become required
// once serviceOffered is actually true.
const importItemSchema = Joi.object({
  reference: Joi.string().required(),
  name: Joi.string().required(),
  price: Joi.number().min(0).required(),
  quantity: Joi.number().integer().min(0).required(),
  supplierId: Joi.number().integer(),
  supplierName: Joi.string(),
  supplierAddress: Joi.string().allow(''),
  supplierPhone: Joi.string().allow(''),
  serviceOffered: Joi.boolean(),
  serviceName: Joi.string().allow(''),
  servicePrice: Joi.number().min(0),
}).when('.serviceOffered', {
  is: true,
  then: Joi.object({
    serviceName: Joi.string().min(1).required(),
    servicePrice: Joi.number().min(0).required(),
  }),
});

export const importProductsBatch: ValidationSchema = {
  body: Joi.object().keys({
    // Fallback supplier for any item that doesn't specify its own — optional
    // since every item can instead carry its own supplierId/supplierName.
    supplierId: Joi.number().integer(),
    items: Joi.array().items(importItemSchema).required(),
  }),
};


import Joi from 'joi';
import { ValidationSchema } from '../middlewares/validate.js';

export const orderParams: ValidationSchema = {
  params: Joi.object().keys({
    number: Joi.string().required(),
  }),
};

export const alertParams: ValidationSchema = {
  params: Joi.object().keys({
    id: Joi.number().integer().required(),
  }),
};

export const importProductsBatch: ValidationSchema = {
  body: Joi.object().keys({
    // Fallback supplier for any item that doesn't specify its own — optional
    // since every item can instead carry its own supplierId/supplierName.
    supplierId: Joi.number().integer(),
    items: Joi.array()
      .items(
        Joi.object().keys({
          reference: Joi.string().required(),
          name: Joi.string().required(),
          price: Joi.number().required(),
          quantity: Joi.number().required(),
          supplierId: Joi.number().integer(),
          supplierName: Joi.string(),
          supplierNif: Joi.string().allow(''),
          supplierProvince: Joi.string().allow(''),
          serviceOffered: Joi.boolean(),
          serviceName: Joi.string().allow(''),
          servicePrice: Joi.number(),
        })
      )
      .required(),
  }),
};

export const importProductsFile: ValidationSchema = {
  body: Joi.object().keys({
    // Fallback supplier for any row in the file without its own supplier
    // columns — optional, since a file can carry a per-row supplier instead.
    supplierId: Joi.number().integer(),
    supplierName: Joi.string(),
    supplierNif: Joi.string().allow(''),
    supplierProvince: Joi.string().allow(''),
  }),
};

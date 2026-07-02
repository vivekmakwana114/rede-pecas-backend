import Joi from 'joi';
import { ValidationSchema } from '../middlewares/validate.js';

export const login: ValidationSchema = {
  body: Joi.object().keys({
    password: Joi.string().required(),
  }),
};

export const orderParams: ValidationSchema = {
  params: Joi.object().keys({
    number: Joi.string().required(),
  }),
};

export const importPartsBatch: ValidationSchema = {
  body: Joi.object().keys({
    supplierId: Joi.number().integer().required(),
    items: Joi.array()
      .items(
        Joi.object().keys({
          reference: Joi.string().required(),
          name: Joi.string().required(),
          price: Joi.number().required(),
          quantity: Joi.number().required(),
        })
      )
      .required(),
  }),
};

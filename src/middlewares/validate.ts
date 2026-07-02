import { Request, Response, NextFunction } from 'express';
import Joi, { Schema } from 'joi';
import { pick } from '../utils/pick.js';
import { ApiError } from '../utils/ApiError.js';

export interface ValidationSchema {
  params?: Schema;
  query?: Schema;
  body?: Schema;
}

export const validate = (schema: ValidationSchema) => (req: Request, res: Response, next: NextFunction) => {
  const validSchema = pick(schema, ['params', 'query', 'body']);
  const object = pick(req, Object.keys(validSchema));
  const { value, error } = Joi.compile(validSchema)
    .prefs({ errors: { label: 'key' } })
    .validate(object);

  if (error) {
    const errorMessage = error.details.map((details) => details.message).join(', ');
    return next(new ApiError(400, errorMessage));
  }
  Object.assign(req, value);
  return next();
};

export default validate;

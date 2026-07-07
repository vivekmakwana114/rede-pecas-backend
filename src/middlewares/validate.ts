import { Request, Response, NextFunction } from 'express';
import Joi, { Schema } from 'joi';
import { pick } from '../utils/pick.js';
import { ApiError } from '../utils/ApiError.js';

export interface ValidationSchema {
  params?: Schema;
  query?: Schema;
  body?: Schema;
}

/**
 * Joi's raw messages quote the field's camelCase/snake_case key verbatim
 * (`"newPassword" is required`) — turns that into a readable label
 * (`New Password is required`) instead of exposing Joi's own phrasing.
 */
function humanizeField(field: string): string {
  const spaced = field
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function humanizeMessage(raw: string): string {
  return raw
    .replace(/^"([^"]+)"/, (_match, field) => humanizeField(field))
    .replace(/\s+/g, ' ')
    .trim();
}

export const validate = (schema: ValidationSchema) => (req: Request, res: Response, next: NextFunction) => {
  const validSchema = pick(schema, ['params', 'query', 'body']);
  const object = pick(req, Object.keys(validSchema));
  const { value, error } = Joi.compile(validSchema)
    .prefs({ errors: { label: 'key' } })
    .validate(object);

  if (error) {
    const errorMessage = error.details.map((details) => humanizeMessage(details.message)).join(', ');
    return next(new ApiError(400, errorMessage));
  }
  Object.assign(req, value);
  return next();
};

export default validate;

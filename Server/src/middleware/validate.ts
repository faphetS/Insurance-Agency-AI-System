import type { NextFunction, Request, Response } from "express";
import { ZodSchema } from "zod";

interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

/**
 * Middleware factory that validates request body, params, and/or query using Zod schemas.
 * On failure, throws the ZodError which is caught by the global error handler.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (schemas.body) {
      req.body = schemas.body.parse(req.body);
    }
    // In Express 5, req.params and req.query are getter-only — direct
    // assignment throws "Cannot set property ... which has only a getter".
    // Redefine them as data properties holding the validated/coerced values.
    if (schemas.params) {
      Object.defineProperty(req, "params", {
        value: schemas.params.parse(req.params),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    if (schemas.query) {
      Object.defineProperty(req, "query", {
        value: schemas.query.parse(req.query),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    next();
  };
}

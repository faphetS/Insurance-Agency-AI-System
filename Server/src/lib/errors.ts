import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public isOperational = true,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(404, `${resource} not found`, "NOT_FOUND");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message, "FORBIDDEN");
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed") {
    super(400, message, "VALIDATION_ERROR");
  }
}

function formatZodError(error: ZodError) {
  return error.errors.map((e) => ({
    path: e.path.join("."),
    message: e.message,
  }));
}

export const globalErrorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  _next,
) => {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      status: "error",
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      errors: formatZodError(err),
    });
    return;
  }

  // Known operational errors
  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.fatal({ err, requestId: req.id }, "Non-operational error");
    } else {
      logger.warn({ err, requestId: req.id }, err.message);
    }

    res.status(err.statusCode).json({
      status: "error",
      code: err.code,
      message: err.message,
    });
    return;
  }

  // Unknown / programmer errors — never leak details in production
  logger.error({ err, requestId: req.id }, "Unhandled error");

  res.status(500).json({
    status: "error",
    code: "INTERNAL_ERROR",
    message:
      env.NODE_ENV === "development"
        ? err.message
        : "An unexpected error occurred",
    ...(env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

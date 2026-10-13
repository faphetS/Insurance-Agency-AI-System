import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError, ForbiddenError, UnauthorizedError } from "../lib/errors.js";

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Compares UTF-8 byte lengths, not string lengths: timingSafeEqual throws on unequal byte
// lengths, so a same-length non-ASCII header would otherwise surface as a 500 instead of a 401.
function tokenMatches(token: string, expected: string): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid authorization header");
  }

  if (!tokenMatches(header.slice(7), env.ADMIN_API_TOKEN)) {
    throw new UnauthorizedError("Invalid token");
  }

  req.user = { id: "admin", email: "", role: "admin" };
  next();
}

export async function authenticateSettings(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const expected = env.SETTINGS_PASSWORD;
  if (!expected) {
    throw new AppError(503, "settings page is not configured", "SETTINGS_DISABLED");
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid authorization header");
  }

  if (!tokenMatches(header.slice(7), expected)) {
    throw new UnauthorizedError("Invalid password");
  }

  req.user = { id: "settings", email: "", role: "settings" };
  next();
}

export function authorize(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError("Insufficient permissions");
    }
    next();
  };
}

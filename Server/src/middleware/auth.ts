import type { NextFunction, Request, Response } from "express";
import { jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env.js";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";

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

const secret = new TextEncoder().encode(env.JWT_SECRET);

/**
 * Extracts and verifies the JWT from the Authorization header.
 * Attaches the decoded user to req.user.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid authorization header");
  }

  const token = header.slice(7);

  try {
    const { payload } = await jwtVerify(token, secret);
    req.user = extractUser(payload);
    next();
  } catch {
    throw new UnauthorizedError("Invalid or expired token");
  }
}

/**
 * Middleware factory that restricts access to specific roles.
 * Must be used after `authenticate`.
 */
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

function extractUser(payload: JWTPayload): AuthUser {
  return {
    id: payload.sub ?? "",
    email: (payload.email as string) ?? "",
    role: (payload.role as string) ?? "customer",
  };
}

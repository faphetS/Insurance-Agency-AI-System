import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
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

/**
 * Verifies the JWT from the Authorization header via Supabase's authoritative
 * getUser call. Attaches the decoded user to req.user.
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

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    throw new UnauthorizedError("Invalid or expired token");
  }

  req.user = {
    id: data.user.id,
    email: data.user.email ?? "",
    role:
      (data.user.app_metadata?.role as string | undefined) ?? "authenticated",
  };

  next();
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

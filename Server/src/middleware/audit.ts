import type { NextFunction, Request, Response } from "express";
import { logger } from "../config/logger.js";
import { supabaseAdmin } from "../config/supabase.js";

/**
 * Middleware that logs data-mutating requests (POST, PUT, PATCH, DELETE)
 * to an audit_logs table in Supabase for compliance.
 */
export function audit(req: Request, res: Response, next: NextFunction) {
  // Only audit mutations, not reads
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }

  // Fire-and-forget — don't block the response
  res.on("finish", () => {
    const entry = {
      user_id: req.user?.id ?? null,
      action: `${req.method} ${req.originalUrl}`,
      status_code: res.statusCode,
      ip_address: req.ip,
      user_agent: req.headers["user-agent"] ?? null,
      request_id: req.id,
      timestamp: new Date().toISOString(),
    };

    supabaseAdmin
      .from("audit_logs")
      .insert(entry)
      .then(({ error }) => {
        if (error) {
          logger.warn({ error, entry }, "Failed to write audit log");
        }
      });
  });

  next();
}

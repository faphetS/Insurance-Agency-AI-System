import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { CLIENT_DOCS_BUCKET } from "../../lib/storage.js";

const router = Router();

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  gif: "image/gif",
  txt: "text/plain",
  json: "application/json",
};

function mimeForPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// GET /files/* — serves a file from STORAGE_DIR/client-documents/
// Auth is the HMAC signature in the query string (no JWT required).
// Express 5 requires a *named* wildcard ("/*splat"); the bare "/*" form is
// rejected by path-to-regexp v8 at registration time.
router.get("/*splat", async (req: Request, res: Response) => {
  // Express 5 URL-decodes wildcard segments and exposes them as an array.
  const splat = (req.params as Record<string, string | string[]>)["splat"];
  const relPath = Array.isArray(splat) ? splat.join("/") : String(splat ?? "");

  const exp = req.query["exp"] as string | undefined;
  const sig = req.query["sig"] as string | undefined;

  if (!exp || !sig) {
    res.status(401).json({ status: "error", code: "UNAUTHORIZED", message: "Missing signature" });
    return;
  }

  // Expiry check
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) {
    res.status(401).json({ status: "error", code: "UNAUTHORIZED", message: "Link expired" });
    return;
  }

  // HMAC verification — constant-time compare
  const expected = crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(`${relPath}.${exp}`)
    .digest("hex");

  let sigMatches: boolean;
  try {
    sigMatches = crypto.timingSafeEqual(
      Buffer.from(sig, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    sigMatches = false;
  }

  if (!sigMatches) {
    res.status(403).json({ status: "error", code: "FORBIDDEN", message: "Invalid signature" });
    return;
  }

  // Path traversal guard
  const normalized = path.normalize(relPath);
  if (
    normalized.includes("..") ||
    path.isAbsolute(normalized)
  ) {
    res.status(403).json({ status: "error", code: "FORBIDDEN", message: "Invalid path" });
    return;
  }

  const bucketDir = path.resolve(env.STORAGE_DIR, CLIENT_DOCS_BUCKET);
  const absPath = path.resolve(bucketDir, normalized);

  // Ensure resolved path stays inside bucket dir
  if (!absPath.startsWith(bucketDir + path.sep) && absPath !== bucketDir) {
    logger.warn({ relPath, absPath, bucketDir }, "files: path escape attempt");
    res.status(403).json({ status: "error", code: "FORBIDDEN", message: "Invalid path" });
    return;
  }

  // Verify file exists
  try {
    await fs.access(absPath);
  } catch {
    res.status(404).json({ status: "error", code: "NOT_FOUND", message: "File not found" });
    return;
  }

  res.setHeader("Content-Type", mimeForPath(absPath));
  res.sendFile(absPath);
});

export default router;

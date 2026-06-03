import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export const CLIENT_DOCS_BUCKET = "client-documents";

export async function ensureClientDocumentsBucket(): Promise<boolean> {
  try {
    await fs.mkdir(path.join(env.STORAGE_DIR, CLIENT_DOCS_BUCKET), { recursive: true });
    return true;
  } catch (err) {
    logger.warn({ err }, "ensureClientDocumentsBucket: mkdir failed");
    return false;
  }
}

export function extFor(mimeType?: string | null, fileName?: string | null): string {
  if (mimeType) {
    switch (mimeType.toLowerCase().split(";")[0]?.trim()) {
      case "image/jpeg": return "jpg";
      case "image/png": return "png";
      case "image/webp": return "webp";
      case "image/heic": return "heic";
      case "image/heif": return "heif";
      case "application/pdf": return "pdf";
    }
  }

  if (fileName) {
    const clean = fileName.split("?")[0] ?? "";
    const dot = clean.lastIndexOf(".");
    if (dot !== -1) {
      const ext = clean.slice(dot + 1).toLowerCase();
      if (ext) return ext;
    }
  }

  return "bin";
}

export async function persistRemoteFile(
  sourceUrl: string,
  destPath: string,
  contentType?: string,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    let res: Response;
    try {
      res = await fetch(sourceUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      logger.warn({ sourceUrl, status: res.status }, "persistRemoteFile: fetch failed");
      return null;
    }

    const contentLength = res.headers.get("Content-Length");
    if (contentLength && Number(contentLength) > 15 * 1024 * 1024) {
      logger.warn({ sourceUrl, contentLength }, "persistRemoteFile: file exceeds 15MB limit");
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());

    if (buf.byteLength > 15 * 1024 * 1024) {
      logger.warn({ sourceUrl, size: buf.byteLength }, "persistRemoteFile: downloaded file exceeds 15MB");
      return null;
    }

    const absPath = path.join(env.STORAGE_DIR, CLIENT_DOCS_BUCKET, destPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, buf);

    return destPath;
  } catch (err) {
    logger.warn({ err, sourceUrl, destPath }, "persistRemoteFile: unexpected error");
    return null;
  }
}

export async function getSignedDocUrl(
  filePath: string,
  expiresInSec: number,
): Promise<string | null> {
  if (/^https?:\/\//i.test(filePath)) return filePath;

  try {
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const sig = crypto
      .createHmac("sha256", env.JWT_SECRET)
      .update(`${filePath}.${exp}`)
      .digest("hex");

    const encodedPath = filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    return `${env.BACKEND_URL}/files/${encodedPath}?exp=${exp}&sig=${sig}`;
  } catch (err) {
    logger.warn({ err, filePath }, "getSignedDocUrl: unexpected error");
    return null;
  }
}

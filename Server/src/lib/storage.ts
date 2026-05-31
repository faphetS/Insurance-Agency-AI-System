import { supabaseAdmin } from "../config/supabase.js";
import { logger } from "../config/logger.js";

export const CLIENT_DOCS_BUCKET = "client-documents";

export async function ensureClientDocumentsBucket(): Promise<boolean> {
  try {
    const { error: getError } = await supabaseAdmin.storage.getBucket(CLIENT_DOCS_BUCKET);
    if (!getError) return false;

    const { error: createError } = await supabaseAdmin.storage.createBucket(CLIENT_DOCS_BUCKET, {
      public: false,
      fileSizeLimit: "15MB",
      allowedMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
        "application/pdf",
      ],
    });

    if (createError && !createError.message.toLowerCase().includes("already exists")) {
      logger.warn({ err: createError }, "ensureClientDocumentsBucket: createBucket failed");
      return false;
    }

    return true;
  } catch (err) {
    logger.warn({ err }, "ensureClientDocumentsBucket: unexpected error");
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

    const ct = contentType ?? res.headers.get("content-type") ?? "application/octet-stream";

    const { data, error } = await supabaseAdmin.storage
      .from(CLIENT_DOCS_BUCKET)
      .upload(destPath, buf, { contentType: ct, upsert: true });

    if (error) {
      logger.warn({ err: error, destPath }, "persistRemoteFile: storage upload failed");
      return null;
    }

    return data?.path ?? null;
  } catch (err) {
    logger.warn({ err, sourceUrl, destPath }, "persistRemoteFile: unexpected error");
    return null;
  }
}

export async function getSignedDocUrl(
  path: string,
  expiresInSec: number,
): Promise<string | null> {
  if (/^https?:\/\//i.test(path)) return path;

  try {
    const { data, error } = await supabaseAdmin.storage
      .from(CLIENT_DOCS_BUCKET)
      .createSignedUrl(path, expiresInSec);

    if (error) {
      logger.warn({ err: error, path }, "getSignedDocUrl: createSignedUrl failed");
      return null;
    }

    return data?.signedUrl ?? null;
  } catch (err) {
    logger.warn({ err, path }, "getSignedDocUrl: unexpected error");
    return null;
  }
}

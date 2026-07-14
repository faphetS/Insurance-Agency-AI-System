import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { supabaseAdmin } from "../../../config/supabase.js";
import { uploadMedia } from "./meta.transport.js";

const MAX_BYTES = 15 * 1024 * 1024;

interface MetaMediaInfo {
  url?: string;
  mime_type?: string;
}

function graphBase(): string {
  return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION ?? "v24.0"}`;
}

async function getMediaInfo(mediaId: string, token: string): Promise<MetaMediaInfo | null> {
  const res = await fetch(`${graphBase()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn({ mediaId, status: res.status, body: text }, "downloadMetaMedia: media info fetch failed");
    return null;
  }
  return (await res.json()) as MetaMediaInfo;
}

// Same AbortController/size-cap pattern as lib/storage's fetchRemoteFile, plus
// the Bearer header Meta's CDN URLs require.
async function fetchMediaBytes(url: string, token: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      logger.warn({ status: res.status }, "downloadMetaMedia: media download failed");
      return null;
    }

    const contentLength = res.headers.get("Content-Length");
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      logger.warn({ contentLength }, "downloadMetaMedia: file exceeds 15MB limit");
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());

    if (buf.byteLength > MAX_BYTES) {
      logger.warn({ size: buf.byteLength }, "downloadMetaMedia: downloaded file exceeds 15MB");
      return null;
    }

    return buf;
  } catch (err) {
    logger.warn({ err }, "downloadMetaMedia: unexpected download error");
    return null;
  }
}

/**
 * Resolve a Meta media id to bytes: GET /<id> for the (5-minute) CDN URL, then
 * a Bearer download. On failure the id is re-resolved once (expired-URL path).
 */
export async function downloadMetaMedia(
  mediaId: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const token = env.META_ACCESS_TOKEN;
  if (!token) {
    logger.warn({ mediaId }, "downloadMetaMedia: META_ACCESS_TOKEN not set — skipping");
    return null;
  }

  try {
    let info = await getMediaInfo(mediaId, token);
    if (!info?.url) return null;

    let bytes = await fetchMediaBytes(info.url, token);
    if (!bytes) {
      info = await getMediaInfo(mediaId, token);
      if (!info?.url) return null;
      bytes = await fetchMediaBytes(info.url, token);
      if (!bytes) return null;
    }

    return { bytes, mimeType: info.mime_type ?? "application/octet-stream" };
  } catch (err) {
    logger.warn({ err, mediaId }, "downloadMetaMedia: unexpected error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Brand image (welcome bubble) — uploaded once, id cached in system_settings
// (Meta persists uploaded media ids for 30 days; re-upload on send failure).
// ---------------------------------------------------------------------------

const BRAND_MEDIA_KEY = "meta_media_id:brand.jpeg";

let brandMediaIdMemo: string | null = null;

// Same assets-dir resolution as server.ts (Server/assets, relative to src|dist).
function brandAssetPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../assets/brand.jpeg",
  );
}

export async function getBrandImageMediaId(): Promise<string | null> {
  if (brandMediaIdMemo) return brandMediaIdMemo;

  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", BRAND_MEDIA_KEY)
    .maybeSingle();

  const stored = (data?.value as string | null) ?? null;
  if (stored) {
    brandMediaIdMemo = stored;
    return stored;
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(brandAssetPath());
  } catch (err) {
    logger.warn({ err }, "getBrandImageMediaId: brand asset read failed");
    return null;
  }

  let mediaId: string;
  try {
    mediaId = await uploadMedia(bytes, "image/jpeg");
  } catch (err) {
    logger.warn({ err }, "getBrandImageMediaId: media upload failed");
    return null;
  }

  await supabaseAdmin
    .from("system_settings")
    .upsert(
      { key: BRAND_MEDIA_KEY, value: mediaId, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );

  brandMediaIdMemo = mediaId;
  logger.info({ mediaId }, "getBrandImageMediaId: brand image uploaded to Meta");
  return mediaId;
}

export async function invalidateBrandMediaId(): Promise<void> {
  brandMediaIdMemo = null;
  await supabaseAdmin.from("system_settings").delete().eq("key", BRAND_MEDIA_KEY);
}

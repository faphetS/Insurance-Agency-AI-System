import { logger } from "../../config/logger.js";
import { fetchRemoteFile } from "../../lib/storage.js";
import { downloadMetaMedia } from "./meta/meta.media.js";
import type { MessagePayload } from "./whatsapp.validator.js";

export interface InboundMedia {
  bytes: Buffer;
  mimeType: string;
}

const OCTET_STREAM = "application/octet-stream";

// The Chatwoot mirror, the id_photo step and the Drive capture all get the same payload
// object from the inbound pipeline: keyed on it, they share one download.
const downloads = new WeakMap<MessagePayload, Promise<InboundMedia | null>>();

async function fetchInboundMedia(payload: MessagePayload): Promise<InboundMedia | null> {
  if (payload.kind === "text") return null;
  const fallbackMime = payload.kind === "image" ? "image/jpeg" : OCTET_STREAM;
  try {
    if (payload.kind !== "other" && payload.fileUrl) {
      const bytes = await fetchRemoteFile(payload.fileUrl);
      return bytes ? { bytes, mimeType: payload.mimeType ?? fallbackMime } : null;
    }
    if (payload.mediaId) {
      const media = await downloadMetaMedia(payload.mediaId);
      if (!media) return null;
      // downloadMetaMedia reports a missing mime as octet-stream, which says nothing.
      const metaMime = media.mimeType === OCTET_STREAM ? undefined : media.mimeType;
      return { bytes: media.bytes, mimeType: payload.mimeType ?? metaMime ?? fallbackMime };
    }
    return null;
  } catch (err) {
    logger.warn({ err, kind: payload.kind }, "inbound-media: download failed");
    return null;
  }
}

/** Bytes + mime of the file an inbound message carries; null when it has none or the download failed. */
export function downloadInboundMedia(payload: MessagePayload): Promise<InboundMedia | null> {
  const pending = downloads.get(payload);
  if (pending) return pending;

  const download: Promise<InboundMedia | null> = fetchInboundMedia(payload).then((media) => {
    // A failure is not remembered: a later caller tries again on its own.
    if (!media && downloads.get(payload) === download) downloads.delete(payload);
    return media;
  });
  downloads.set(payload, download);
  return download;
}

/** Resolve inbound media bytes: GreenAPI delivers a fileUrl, Meta a mediaId. */
export async function resolveInboundMedia(payload: MessagePayload): Promise<Buffer | null> {
  if (payload.kind !== "image" && payload.kind !== "document") return null;
  const media = await downloadInboundMedia(payload);
  return media?.bytes ?? null;
}

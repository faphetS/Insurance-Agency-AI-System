import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import type { MessagePayload } from "../whatsapp/whatsapp.validator.js";
import { fetchRemoteFile, extFor } from "../../lib/storage.js";
import { downloadMetaMedia } from "../whatsapp/meta/meta.media.js";
import { uploadLeadDocument } from "../integrations/google/google.drive.js";
import { mirrorLeadToSheet } from "../integrations/google/leads-mirror.service.js";
import { displayName } from "../whatsapp/whatsapp.util.js";

/** Resolve inbound media bytes: GreenAPI delivers a fileUrl, Meta a mediaId. */
export async function resolveInboundMedia(payload: MessagePayload): Promise<Buffer | null> {
  if (payload.kind === "text") return null;
  if (payload.fileUrl) {
    return fetchRemoteFile(payload.fileUrl);
  }
  if (payload.mediaId) {
    const media = await downloadMetaMedia(payload.mediaId);
    return media?.bytes ?? null;
  }
  return null;
}

/** Israel-local stamp for Drive file names — ":" is unsafe in a file name, so "." separates. */
function driveStamp(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}.${get("minute")}.${get("second")}`;
}

/**
 * Archive a file a lead sent while intake was running: Drive upload, `documents` row,
 * and the link into the CRM sheet (column D) via the normal mirror.
 *
 * Best-effort — never throws, never blocks the bot reply. The `id_photo` slot does NOT
 * come through here: that path runs OCR first and owns the verified `id_photo_url`.
 */
export async function captureIntakeDocument(
  clientId: string,
  payload: MessagePayload,
): Promise<void> {
  if (payload.kind !== "image" && payload.kind !== "document") return;

  try {
    const { data } = await supabaseAdmin
      .from("clients")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("phone, full_name, id_validated" as any)
      .eq("id", clientId)
      .maybeSingle();

    const client = (data ?? null) as {
      phone?: string | null;
      full_name?: string | null;
      id_validated?: boolean | null;
    } | null;

    if (!client?.phone) {
      logger.warn({ clientId }, "intake-media: client has no phone — skipping capture");
      return;
    }

    const bytes = await resolveInboundMedia(payload);
    if (!bytes) {
      logger.warn({ clientId, kind: payload.kind }, "intake-media: inbound media download failed");
      return;
    }

    const mimeType =
      payload.mimeType ?? (payload.kind === "image" ? "image/jpeg" : "application/octet-stream");
    const base = displayName(client.full_name, client.phone) ?? client.phone.replace(/\D/g, "");

    const up = await uploadLeadDocument({
      name: `${base} - ${driveStamp()}.${extFor(mimeType, payload.fileName)}`,
      mimeType,
      bytes,
    });
    if (!up) return; // uploadLeadDocument already logged why

    await supabaseAdmin.from("documents").insert({
      client_id: clientId,
      type: "other",
      file_url: up.webViewLink,
      file_name: payload.fileName ?? null,
      mime_type: mimeType,
    });

    // An OCR-verified ID photo outranks anything captured here — never overwrite it.
    if (client.id_validated) {
      logger.info({ clientId, fileId: up.fileId }, "intake-media: archived to Drive (verified ID kept in sheet)");
      return;
    }

    await supabaseAdmin
      .from("clients")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ id_photo_url: up.webViewLink } as any)
      .eq("id", clientId);

    await mirrorLeadToSheet(clientId);

    logger.info(
      { clientId, kind: payload.kind, fileId: up.fileId },
      "intake-media: lead document archived to Drive and mirrored to the sheet",
    );
  } catch (err) {
    logger.error({ err, clientId }, "intake-media: capture failed — continuing");
  }
}

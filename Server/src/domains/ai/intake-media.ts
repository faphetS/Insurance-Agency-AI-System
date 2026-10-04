import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import type { MessagePayload } from "../whatsapp/whatsapp.validator.js";
import { fetchRemoteFile, extFor } from "../../lib/storage.js";
import { downloadMetaMedia } from "../whatsapp/meta/meta.media.js";
import { uploadLeadDocument } from "../integrations/google/google.drive.js";
import { mirrorLeadToSheet } from "../integrations/google/leads-mirror.service.js";
import { displayName } from "../whatsapp/whatsapp.util.js";
import { validateIdPhoto } from "./ai.service.js";

/** Resolve inbound media bytes: GreenAPI delivers a fileUrl, Meta a mediaId. */
export async function resolveInboundMedia(payload: MessagePayload): Promise<Buffer | null> {
  if (payload.kind !== "image" && payload.kind !== "document") return null;
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
 * Archive any file a known lead sends: Drive upload, `documents` row, CRM-sheet sync.
 * Images (including photos sent "as a file") are first run through the strict ID check;
 * a valid תעודת זהות + ספח photo also fills the client's ID number and name.
 *
 * Best-effort and silent — never throws, never replies to the lead, never blocks the bot.
 * The pipeline does not call this for an image the `id_photo` step took (handleIntake
 * reports `fileHandled`): that step runs its own OCR-gated upload and replies.
 *
 * The shim resolves `{ error }` instead of throwing, so every query is checked. Only code +
 * message are logged: Postgres' DETAIL ("Failing row contains (…)") would put the row, ID
 * number and name included, in the logs.
 */
export async function captureLeadFile(clientId: string, payload: MessagePayload): Promise<void> {
  if (payload.kind !== "image" && payload.kind !== "document") return;

  try {
    const { data, error: readErr } = await supabaseAdmin
      .from("clients")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("phone, full_name" as any)
      .eq("id", clientId)
      .maybeSingle();

    if (readErr) {
      logger.error(
        { clientId, code: readErr.code, message: readErr.message },
        "intake-media: client read failed — skipping capture",
      );
      return;
    }

    const client = (data ?? null) as { phone?: string | null; full_name?: string | null } | null;

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
    const ocr = mimeType.startsWith("image/") ? await inspectIdPhoto(bytes, mimeType) : null;
    const idPhoto = ocr && ocr.valid ? ocr : null;

    const ext = extFor(mimeType, payload.fileName);
    const base = displayName(client.full_name, client.phone) ?? client.phone.replace(/\D/g, "");
    const name = idPhoto?.fullName ? `${idPhoto.fullName} - ID.${ext}` : `${base} - ${driveStamp()}.${ext}`;

    const up = await uploadLeadDocument({ name, mimeType, bytes });
    if (!up) {
      // uploadLeadDocument logs why, but without identifiers; this line says whom to ask to resend.
      logger.warn({ clientId, kind: payload.kind, mimeType }, "intake-media: Drive upload failed — file not archived");
      return;
    }

    // Column D is rebuilt from `documents` alone: without this row the link never reaches the
    // sheet. The fileId lets staff find the file in Drive.
    const { error: docErr } = await supabaseAdmin.from("documents").insert({
      client_id: clientId,
      type: idPhoto ? "id_photo" : "other",
      file_url: up.webViewLink,
      file_name: payload.fileName ?? null,
      mime_type: mimeType,
    });
    if (docErr) {
      logger.error(
        { clientId, fileId: up.fileId, code: docErr.code, message: docErr.message },
        "intake-media: documents insert failed — file is in Drive but not listed in column D",
      );
    }

    // Saved even when the documents row failed: the number and name do not depend on it.
    let clientErr: { code?: string; message: string } | null = null;
    if (idPhoto) {
      // Newest verified ID wins; a client is never downgraded (id_validated only ever becomes true).
      // The name moves only together with a readable number, so columns B and E always describe
      // the same card — a family member's ID with an unreadable number changes neither.
      const { error } = await supabaseAdmin
        .from("clients")
        .update({
          id_photo_url: up.webViewLink,
          ...(idPhoto.idNumber
            ? {
                id_number: idPhoto.idNumber,
                id_validated: true,
                ...(idPhoto.fullName ? { full_name: idPhoto.fullName } : {}),
              }
            : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .eq("id", clientId);
      clientErr = error;
      if (clientErr) {
        logger.error(
          { clientId, fileId: up.fileId, code: clientErr.code, message: clientErr.message },
          "intake-media: client ID update failed — number and name not saved",
        );
      }
      if (!idPhoto.idNumber) {
        logger.warn({ clientId, fileId: up.fileId }, "intake-media: ID photo without a readable number — columns B and E unchanged");
      }
    }

    const docSaved = !docErr;
    const idSaved = idPhoto !== null && !clientErr;
    // When neither write landed the sheet has nothing new to show.
    if (docSaved || idSaved) await mirrorLeadToSheet(clientId);

    const summary = {
      clientId,
      kind: payload.kind,
      mimeType,
      isIdPhoto: idPhoto !== null,
      hasIdCard: ocr?.hasIdCard ?? null,
      hasAppendix: ocr?.hasAppendix ?? null,
      idOk: !!idPhoto?.idNumber,
      fileId: up.fileId,
      docSaved,
      clientSaved: idPhoto ? idSaved : null,
    };
    // "archived" is the success marker the rollout greps for: only a fully recorded file earns it.
    if (docSaved && !clientErr) {
      logger.info(summary, "intake-media: lead file archived");
    } else {
      logger.warn(summary, "intake-media: lead file is in Drive but not fully recorded");
    }
  } catch (err) {
    logger.error({ err, clientId }, "intake-media: capture failed — continuing");
  }
}

// The vision pass is best-effort here: a model or API failure means "not an ID",
// never a lost file. The bytes go as a data URL because Meta media URLs need a
// Bearer header OpenRouter cannot send.
async function inspectIdPhoto(
  bytes: Buffer,
  mimeType: string,
): Promise<Awaited<ReturnType<typeof validateIdPhoto>> | null> {
  try {
    return await validateIdPhoto(`data:${mimeType};base64,${bytes.toString("base64")}`);
  } catch (err) {
    logger.warn({ err }, "intake-media: ID inspection failed — archiving as a plain file");
    return null;
  }
}

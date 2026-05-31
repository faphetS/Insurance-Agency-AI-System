// Advisory AI cross-check: compares the meeting summary text against what
// BAFI actually recorded (forms / receipt / policy / deposit presence).
// The output is a human-readable Hebrew assessment for the assigned agent —
// it is NOT authoritative; the existence-based pass/fail in bafiProvider.crossCheck
// remains the machine gate. This module only produces the advisory artifact.
//
// Assumptions:
// - "most recent meeting" is determined by scheduled_at DESC for the client.
// - We prefer summary_final; fall back to summary_draft if final is absent.
// - If the AI call fails or no summary exists, we degrade silently — the
//   calling site (operations.checker.ts) continues normally.

import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { generateReply } from "../ai/ai.service.js";
import { createNotification } from "./operations.service.js";
import { sendMessageWithTyping } from "../whatsapp/whatsapp.service.js";
import { toChatId } from "../whatsapp/whatsapp.util.js";

interface CrossCheckFlags {
  forms: boolean;
  receipt: boolean;
  policy: boolean;
  deposit: boolean;
}

async function resolveAssignedStaffPhone(
  clientId: string,
): Promise<{ staffId: string; chatId: string } | null> {
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("assigned_handler_id, assigned_to")
    .eq("id", clientId)
    .maybeSingle();

  const staffId =
    (client?.assigned_handler_id as string | null) ??
    (client?.assigned_to as string | null);

  if (!staffId) return null;

  const { data: staff } = await supabaseAdmin
    .from("staff")
    .select("phone")
    .eq("id", staffId)
    .maybeSingle();

  const chatId = toChatId((staff?.phone as string | null) ?? null);
  if (!chatId) return null;

  return { staffId, chatId };
}

async function loadLatestMeetingSummary(clientId: string): Promise<string | null> {
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("summary_final, summary_draft")
    .eq("client_id", clientId)
    .order("scheduled_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!meeting) return null;

  const text =
    (meeting.summary_final as string | null) ??
    (meeting.summary_draft as string | null);

  return text?.trim() || null;
}

async function askAiForAssessment(
  summaryText: string,
  flags: CrossCheckFlags,
): Promise<string | null> {
  const checkLines = [
    `טפסים: ${flags.forms ? "נמצאו ✅" : "לא נמצאו ❌"}`,
    `קבלה: ${flags.receipt ? "נמצאה ✅" : "לא נמצאה ❌"}`,
    `פוליסה: ${flags.policy ? "נמצאה ✅" : "לא נמצאה ❌"}`,
    `הפקדה: ${flags.deposit ? "נמצאה ✅" : "לא נמצאה ❌"}`,
  ].join("\n");

  const systemPrompt = `אתה עוזר לסוכן ביטוח ישראלי. תפקידך להשוות בין סיכום הפגישה לבין מה שנמצא בפועל במערכת Bafi.
כתוב הערכה קצרה בעברית (עד 5 משפטים) שמציינת:
1. האם מה שהובטח בפגישה מתאים למה שנמצא בפועל.
2. אם יש אי-התאמות — ציין אותן בבירור.
3. אם הכל תואם — ציין זאת בקצרה.
ההערכה היא לעיון האנושי בלבד ואינה החלטה אוטומטית.`;

  const userMessage = `סיכום הפגישה:\n${summaryText}\n\nתוצאות בדיקת Bafi:\n${checkLines}`;

  try {
    const assessment = await generateReply(
      [{ role: "user", text: userMessage }],
      systemPrompt,
      "google/gemini-2.5-flash",
    );
    return assessment.trim() || null;
  } catch (err) {
    logger.warn({ err }, "buildCrossCheckAssessment: AI call failed — skipping advisory");
    return null;
  }
}

/**
 * Produces an advisory Hebrew assessment of whether the meeting summary matches
 * BAFI execution, then surfaces it via notification + WhatsApp to the assigned agent.
 * Never throws — all errors are logged and swallowed so the caller continues.
 */
export async function buildCrossCheckAssessment(
  clientId: string,
  taskId: string,
  flags: CrossCheckFlags,
): Promise<void> {
  try {
    const summaryText = await loadLatestMeetingSummary(clientId);
    if (!summaryText) {
      logger.info({ clientId }, "buildCrossCheckAssessment: no meeting summary — skipping advisory");
      return;
    }

    const assessment = await askAiForAssessment(summaryText, flags);
    if (!assessment) return;

    const notifBody = `הצלבת מסמכים (Bafi) — הערכת AI:\n\n${assessment}`;

    const newRow = await createNotification({
      type: "cross_check",
      title: "הצלבת מסמכים Bafi — הערכת AI",
      message: notifBody,
      severity: "warning",
      client_id: clientId,
      task_id: taskId,
      reference_key: `cross_check:${clientId}`,
    });

    // Only WhatsApp the agent if the notification was newly inserted (idempotency).
    if (!newRow) {
      logger.info({ clientId }, "buildCrossCheckAssessment: duplicate notification — skipping WhatsApp");
      return;
    }

    const staffTarget = await resolveAssignedStaffPhone(clientId);
    if (!staffTarget) {
      logger.warn({ clientId }, "buildCrossCheckAssessment: no staff phone — WhatsApp skipped");
      return;
    }

    const waBody = [
      "🔍 הצלבת מסמכים Bafi — הערכת AI לעיונך:",
      "",
      assessment,
    ].join("\n");

    await sendMessageWithTyping(staffTarget.chatId, waBody);
    logger.info(
      { clientId, staffId: staffTarget.staffId },
      "buildCrossCheckAssessment: advisory sent",
    );
  } catch (err) {
    logger.error({ err, clientId }, "buildCrossCheckAssessment: unexpected error — skipping advisory");
  }
}

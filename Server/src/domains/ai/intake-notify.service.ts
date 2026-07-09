import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { INQUIRY_TYPE_HE } from "./intake.prompts.js";
import { sendOwnerEmail } from "../integrations/google/google.gmail.js";
import { toLocalPhone } from "../whatsapp/whatsapp.util.js";

const LIFE_FINANCE_TEAM = [
  "rivka@shaked-ins.com",
  "tzivia@shaked-ins.com",
  "ruth@shaked-ins.com",
  "yafa@shaked-ins.com",
];

const STAFF_ROUTES: Record<string, { to: string[]; firstNameHe: string | null }> = {
  vehicle: { to: ["merav@shaked-ins.com"], firstNameHe: "מירב" },
  home: { to: ["hodaya@shaked-ins.com"], firstNameHe: "הודיה" },
  business: { to: ["giti@shaked-ins.com"], firstNameHe: "גיטי" },
  life_health_pension: { to: LIFE_FINANCE_TEAM, firstNameHe: null },
  finance: { to: LIFE_FINANCE_TEAM, firstNameHe: null },
  // travel + other: intentionally ABSENT — dead silence (owner decision)
};

export async function sendStaffLeadEmail(
  inquiryId: string,
  lead: { phone: string; waName: string | null },
): Promise<void> {
  const route = STAFF_ROUTES[inquiryId];
  if (!route) return;

  const inquiryHe = INQUIRY_TYPE_HE[inquiryId] ?? inquiryId;
  const to = route.to.join(", ");
  const subject = `פנייה חדשה מהבוט — ${inquiryHe}`;
  const greeting = route.firstNameHe ? `היי ${route.firstNameHe},` : "היי,";

  const body =
    `${greeting}\n\n` +
    `התקבלה פנייה חדשה דרך הוואטסאפ של המשרד.\n\n` +
    `סוג הביטוח: ${inquiryHe}\n` +
    `טלפון הלקוח: ${toLocalPhone(lead.phone)}\n` +
    `שם בוואטסאפ: ${lead.waName ?? "לא צוין"}\n\n` +
    `נא ליצור קשר עם הלקוח בהקדם.\n\n` +
    `תודה, דידי`;

  if (env.STAFF_EMAIL_NOTIFY_MODE === "send") {
    await sendOwnerEmail(to, subject, body);
  } else {
    logger.info({ to, subject, body }, "intake-staff-email (DRY RUN — not sent)");
  }
}

export function buildCallbackAlert(phone: string, waName: string | null): string {
  return (
    `📞 בקשת שיחה חוזרת מהבוט` +
    `\nטלפון: ${toLocalPhone(phone)}` +
    `\nשם בוואטסאפ: ${waName ?? "לא צוין"}`
  );
}

export function buildStallAlert(
  phone: string,
  waName: string | null,
  slot: "consent" | "id_photo",
): string {
  const stoppedAt = slot === "consent" ? "אישור הסכמה (מאשר)" : "שליחת צילום תעודת זהות";
  return (
    `⚠️ ליד לא השלים את התהליך` +
    `\nטלפון: ${toLocalPhone(phone)}` +
    `\nשם בוואטסאפ: ${waName ?? "לא צוין"}` +
    `\nנעצר בשלב: ${stoppedAt}`
  );
}

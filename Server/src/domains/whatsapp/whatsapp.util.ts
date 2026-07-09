import { supabaseAdmin } from "../../config/supabase.js";

export function extractButtonId(reqBody: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const md = (reqBody as any)?.messageData ?? {};
  return (
    md.interactiveButtonsResponse?.selectedId ??
    md.interactiveButtonsResponse?.selectedButtonId ??
    md.buttonsResponseMessage?.selectedButtonId ??
    md.templateButtonReplyMessage?.selectedId ??
    ""
  );
}

export function toLocalPhone(raw: string | null | undefined): string {
  const d = (raw ?? "").replace(/\D/g, "");
  const local = d.startsWith("972") ? "0" + d.slice(3) : d;
  return /^0\d{9}$/.test(local) ? local.slice(0, 3) + "-" + local.slice(3) : local;
}

export function displayName(fullName: string | null | undefined, phone: string | null | undefined): string | null {
  const n = (fullName ?? "").trim();
  if (!n) return null;
  const nd = n.replace(/\D/g, "");
  const pd = (phone ?? "").replace(/\D/g, "");
  return pd && nd === pd ? null : n; // full_name that is just the phone => treated as missing
}

export function toChatId(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  let normalized: string;
  if (digits.startsWith("972")) {
    normalized = digits;
  } else if (digits.startsWith("0")) {
    normalized = "972" + digits.slice(1);
  } else if (digits.length === 9) {
    normalized = "972" + digits;
  } else {
    normalized = digits;
  }

  if (normalized.length < 11) return null;

  return `${normalized}@c.us`;
}

export async function isStaffChat(
  chatId: string,
): Promise<{ staffId: string; fullName: string } | null> {
  const { data: staffList } = await supabaseAdmin
    .from("staff")
    .select("id, full_name, phone")
    .eq("is_active", true)
    .not("phone", "is", null);

  if (!staffList) return null;

  const incomingDigits = chatId.replace(/\D/g, "");

  for (const staff of staffList) {
    const staffChatId = toChatId(staff.phone as string | null);
    if (!staffChatId) continue;
    const staffDigits = staffChatId.replace(/\D/g, "");
    if (staffDigits === incomingDigits) {
      return { staffId: staff.id as string, fullName: staff.full_name as string };
    }
  }

  return null;
}

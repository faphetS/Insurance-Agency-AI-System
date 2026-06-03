import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { classifyMailbox } from "../integrations/gmail/gmail.milestones.js";
import type { MilestoneHit } from "../integrations/gmail/gmail.milestones.js";
import type { BafiCheckResult, BafiProvider } from "./operations.types.js";

// Correlation is by client full_name (id_number not stored on the clients table).
// policyNumber / idNumber matching extracted by the LLM is a future enhancement.

interface ClientContext {
  clientFullName: string;
  mailboxStaffId: string;
}

async function loadClientContext(clientId: string): Promise<ClientContext | null> {
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("full_name, assigned_handler_id, assigned_to")
    .eq("id", clientId)
    .maybeSingle();

  if (!client) return null;

  const preferredStaffId: string | null =
    (client.assigned_handler_id as string | null) ??
    (client.assigned_to as string | null);

  // Try the client's own handler's mailbox first.
  if (preferredStaffId) {
    const { data: preferred } = await supabaseAdmin
      .from("gmail_integrations")
      .select("staff_id")
      .eq("staff_id", preferredStaffId)
      .eq("is_active", true)
      .maybeSingle();

    if (preferred) {
      return {
        clientFullName: client.full_name as string,
        mailboxStaffId: preferred.staff_id as string,
      };
    }
  }

  // Fall back to the first active integration (so testing works when the
  // connected Gmail belongs to a different staff member).
  const { data: fallback } = await supabaseAdmin
    .from("gmail_integrations")
    .select("staff_id")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (!fallback) return null;

  return {
    clientFullName: client.full_name as string,
    mailboxStaffId: fallback.staff_id as string,
  };
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function emailMatchesClient(hit: MilestoneHit, clientFullName: string): boolean {
  if (!hit.clientName) return false;
  const a = normalizeName(hit.clientName);
  const b = normalizeName(clientFullName);
  return a === b || a.includes(b) || b.includes(a);
}

async function scanForClient(clientId: string): Promise<MilestoneHit[] | null> {
  const ctx = await loadClientContext(clientId);
  if (!ctx) return null;

  let hits: MilestoneHit[];
  try {
    hits = await classifyMailbox(ctx.mailboxStaffId, {
      q: `"${ctx.clientFullName}" newer_than:90d`,
      maxResults: 25,
    });
  } catch (err) {
    logger.error({ clientId, err }, "EmailMilestoneProvider.scanForClient: classifyMailbox failed");
    return [];
  }

  return hits.filter((h) => emailMatchesClient(h, ctx.clientFullName));
}

export class EmailMilestoneProvider implements BafiProvider {
  async checkForms(clientId: string): Promise<BafiCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };
    return { found: hits.some((h) => h.milestone === "forms_sent") };
  }

  async checkReceipt(clientId: string): Promise<BafiCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };
    return { found: hits.some((h) => h.milestone === "receipt_confirmed") };
  }

  async checkPolicy(clientId: string): Promise<BafiCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };
    return { found: hits.some((h) => h.milestone === "policy_issued") };
  }

  async checkDeposit(clientId: string): Promise<BafiCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };
    return { found: hits.some((h) => h.milestone === "deposit_made") };
  }

  async crossCheck(clientId: string): Promise<BafiCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };

    const forms = hits.some((h) => h.milestone === "forms_sent");
    const receipt = hits.some((h) => h.milestone === "receipt_confirmed");
    const policy = hits.some((h) => h.milestone === "policy_issued");
    const deposit = hits.some((h) => h.milestone === "deposit_made");

    return {
      found: forms && receipt && policy && deposit,
      details: { forms, receipt, policy, deposit },
    };
  }

  async getStaffList(): Promise<Array<{ id: string; name: string; phone?: string }>> {
    try {
      const { data, error } = await supabaseAdmin
        .from("staff")
        .select("id, full_name, phone")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: row.id as string,
        name: row.full_name as string,
        phone: (row.phone as string | null) ?? undefined,
      }));
    } catch (err) {
      logger.error({ method: "getStaffList", err }, "EmailMilestoneProvider: staff query failed");
      return [];
    }
  }
}

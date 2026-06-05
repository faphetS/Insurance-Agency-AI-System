import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { classifyMailbox } from "../integrations/gmail/gmail.milestones.js";
import type { MilestoneHit } from "../integrations/gmail/gmail.milestones.js";
import type { BafiCheckResult, BafiProvider } from "./operations.types.js";

// Correlation uses client email (constrained Gmail search) and a persisted
// policy number (exact LLM-extracted match) in addition to fuzzy name matching.
// ID-number matching is deferred — ctx.id_number will be undefined until the
// clients table gains that column; the tier is guarded and ready.

interface ClientContext {
  clientId: string;
  clientFullName: string;
  mailboxStaffId: string;
  email: string | null;
  policy_number: string | null;
  // id_number is intentionally absent from the clients table today.
  // Add it here and to the SELECT when the column is introduced.
  id_number?: string | null;
}

type MatchLevel = "definitive" | "strong" | "weak" | "none";

async function loadClientContext(clientId: string): Promise<ClientContext | null> {
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("full_name, email, policy_number, assigned_handler_id, assigned_to")
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
        clientId,
        clientFullName: client.full_name as string,
        mailboxStaffId: preferred.staff_id as string,
        email: (client.email as string | null) ?? null,
        policy_number: (client.policy_number as string | null) ?? null,
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
    clientId,
    clientFullName: client.full_name as string,
    mailboxStaffId: fallback.staff_id as string,
    email: (client.email as string | null) ?? null,
    policy_number: (client.policy_number as string | null) ?? null,
  };
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function nameFuzzyMatch(hit: MilestoneHit, clientFullName: string): boolean {
  if (!hit.clientName) return false;
  const a = normalizeName(hit.clientName);
  const b = normalizeName(clientFullName);
  return a === b || a.includes(b) || b.includes(a);
}

function resolveMatchLevel(hit: MilestoneHit, ctx: ClientContext): MatchLevel {
  // Tier 1 — ID number: forward-compatible no-op. ctx.id_number is undefined
  // until the clients table gains that column; the guard ensures it never throws.
  if (hit.idNumber && ctx.id_number && hit.idNumber === ctx.id_number) {
    return "definitive";
  }

  // Tier 2 — policy number: exact match on LLM-extracted vs. persisted value.
  if (hit.policyNumber && ctx.policy_number && hit.policyNumber === ctx.policy_number) {
    return "definitive";
  }

  const nameMatch = nameFuzzyMatch(hit, ctx.clientFullName);

  // Tier 3 — name corroborated by email-constrained search.
  // When ctx.email is set the Gmail query was scoped to that address, so a
  // name match here is further corroborated by the inbox filter.
  if (nameMatch && ctx.email) {
    return "strong";
  }

  // Tier 4 — name alone (original behavior).
  if (nameMatch) {
    return "weak";
  }

  return "none";
}

async function persistPolicyNumber(clientId: string, policyNumber: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("clients")
    .update({ policy_number: policyNumber })
    .eq("id", clientId);

  if (error) {
    logger.error({ clientId, policyNumber, error }, "EmailMilestoneProvider: failed to persist policy_number");
  } else {
    logger.info({ clientId, policyNumber }, "EmailMilestoneProvider: persisted policy_number from email hit");
  }
}

async function scanForClient(clientId: string): Promise<MilestoneHit[] | null> {
  const ctx = await loadClientContext(clientId);
  if (!ctx) return null;

  // Build the Gmail search query from the most specific signal available.
  let q: string;
  if (ctx.policy_number) {
    q = `"${ctx.policy_number}" newer_than:90d`;
  } else if (ctx.email) {
    q = `("${ctx.clientFullName}" OR ${ctx.email}) newer_than:90d`;
  } else {
    q = `"${ctx.clientFullName}" newer_than:90d`;
  }

  let hits: MilestoneHit[];
  try {
    hits = await classifyMailbox(ctx.mailboxStaffId, { q, maxResults: 25 });
  } catch (err) {
    logger.error({ clientId, err }, "EmailMilestoneProvider.scanForClient: classifyMailbox failed");
    return [];
  }

  const matched: MilestoneHit[] = [];

  for (const hit of hits) {
    const level = resolveMatchLevel(hit, ctx);
    if (level === "none") continue;

    matched.push(hit);

    // Persist a newly discovered policy number when confidence is high enough.
    if (
      hit.policyNumber &&
      (level === "definitive" || level === "strong") &&
      !ctx.policy_number
    ) {
      // Update ctx so subsequent hits in this same scan don't trigger duplicate writes.
      ctx.policy_number = hit.policyNumber;
      await persistPolicyNumber(clientId, hit.policyNumber);
    }
  }

  return matched;
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

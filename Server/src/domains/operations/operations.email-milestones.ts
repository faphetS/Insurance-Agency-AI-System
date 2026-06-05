import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { classifyMailbox } from "../integrations/gmail/gmail.milestones.js";
import type { MilestoneHit } from "../integrations/gmail/gmail.milestones.js";
import type { MilestoneCheckResult, MilestoneProvider } from "./operations.types.js";

// Correlation uses client email (constrained Gmail search), a persisted
// policy number, and the Israeli national ID number (when captured during
// intake OCR) for definitive-tier email-to-client matching.

interface ClientContext {
  clientId: string;
  clientFullName: string;
  mailboxStaffId: string;
  email: string | null;
  policy_number: string | null;
  id_number: string | null;
}

export type MatchLevel = "definitive" | "strong" | "weak" | "none";

export interface ClientEmailMatch {
  hit: MilestoneHit;
  level: MatchLevel;
}

async function loadClientContext(clientId: string): Promise<ClientContext | null> {
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("full_name, email, policy_number, id_number, assigned_handler_id, assigned_to")
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
        id_number: (client.id_number as string | null) ?? null,
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
    id_number: (client.id_number as string | null) ?? null,
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

// Build a Gmail query matching ANY of the client's stable identifiers. Searching
// broadly (name + ID + policy + email) is essential: each milestone email
// references the client differently, so narrowing to a single identifier (e.g. a
// persisted policy number) would miss the others.
function buildClientQuery(ctx: ClientContext, window: string): string {
  const terms = [`"${ctx.clientFullName}"`];
  if (ctx.id_number) terms.push(`"${ctx.id_number}"`);
  if (ctx.policy_number) terms.push(`"${ctx.policy_number}"`);
  if (ctx.email) terms.push(ctx.email);
  return `(${terms.join(" OR ")}) ${window}`;
}

async function scanForClient(clientId: string): Promise<MilestoneHit[] | null> {
  const ctx = await loadClientContext(clientId);
  if (!ctx) return null;

  const q = buildClientQuery(ctx, "newer_than:90d");

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

export class EmailMilestoneProvider implements MilestoneProvider {
  async checkForms(clientId: string): Promise<MilestoneCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };
    return { found: hits.some((h) => h.milestone === "forms_sent") };
  }

  async checkReceipt(clientId: string): Promise<MilestoneCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };
    return { found: hits.some((h) => h.milestone === "receipt_confirmed") };
  }

  async checkPolicy(clientId: string): Promise<MilestoneCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };
    return { found: hits.some((h) => h.milestone === "policy_issued") };
  }

  async checkDeposit(clientId: string): Promise<MilestoneCheckResult> {
    const hits = await scanForClient(clientId);
    if (hits === null) return { found: false };
    return { found: hits.some((h) => h.milestone === "deposit_made") };
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

export const milestoneProvider: MilestoneProvider = new EmailMilestoneProvider();

/**
 * Scan a single client's mailbox for actionable insurer emails.
 * Uses the same correlation internals as scanForClient (milestone path) but
 * returns {hit, level}[] and targets a recent 24-hour window suitable for the
 * daily digest. Does NOT write tasks or persist policy numbers.
 */
export async function scanClientEmails(
  clientId: string,
  opts?: { q?: string; maxResults?: number },
): Promise<ClientEmailMatch[] | null> {
  const ctx = await loadClientContext(clientId);
  if (!ctx) return null;

  const q = opts?.q ?? buildClientQuery(ctx, "newer_than:1d");

  let hits: MilestoneHit[];
  try {
    hits = await classifyMailbox(ctx.mailboxStaffId, { q, maxResults: opts?.maxResults ?? 10 });
  } catch (err) {
    logger.error({ clientId, err }, "scanClientEmails: classifyMailbox failed");
    return [];
  }

  const results: ClientEmailMatch[] = [];

  for (const hit of hits) {
    const level = resolveMatchLevel(hit, ctx);
    if (level === "none") continue;
    results.push({ hit, level });
  }

  return results;
}

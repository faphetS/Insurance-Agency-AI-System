import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import { classifyMailbox } from "../integrations/gmail/gmail.milestones.js";
import type { MilestoneHit } from "../integrations/gmail/gmail.milestones.js";
import type { BafiCheckResult, BafiProvider } from "./operations.types.js";

// TODO: correlate the milestone hit to THIS clientId (by clientName / idNumber /
// policyNumber). For now returns found if ANY email in the mailbox shows the
// milestone — correct for single-client testing only.

async function resolveStaffId(): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("gmail_integrations")
    .select("staff_id")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  return data ? (data.staff_id as string) : null;
}

export class EmailMilestoneProvider implements BafiProvider {
  async checkForms(_clientId: string): Promise<BafiCheckResult> {
    const staffId = await resolveStaffId();
    if (!staffId) return { found: false };
    const hits = await classifyMailbox(staffId);
    return { found: hits.some((h) => h.milestone === "forms_sent") };
  }

  async checkReceipt(_clientId: string): Promise<BafiCheckResult> {
    const staffId = await resolveStaffId();
    if (!staffId) return { found: false };
    const hits = await classifyMailbox(staffId);
    return { found: hits.some((h) => h.milestone === "receipt_confirmed") };
  }

  async checkPolicy(_clientId: string): Promise<BafiCheckResult> {
    const staffId = await resolveStaffId();
    if (!staffId) return { found: false };
    const hits = await classifyMailbox(staffId);
    return { found: hits.some((h) => h.milestone === "policy_issued") };
  }

  async checkDeposit(_clientId: string): Promise<BafiCheckResult> {
    const staffId = await resolveStaffId();
    if (!staffId) return { found: false };
    const hits = await classifyMailbox(staffId);
    return { found: hits.some((h) => h.milestone === "deposit_made") };
  }

  async crossCheck(_clientId: string): Promise<BafiCheckResult> {
    const staffId = await resolveStaffId();
    if (!staffId) return { found: false };

    // Single mailbox scan reused across all four checks.
    let hits: MilestoneHit[];
    try {
      hits = await classifyMailbox(staffId);
    } catch (err) {
      logger.error({ err }, "EmailMilestoneProvider.crossCheck: classifyMailbox failed");
      return { found: false };
    }

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

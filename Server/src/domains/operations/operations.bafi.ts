import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { BafiCheckResult, BafiProvider } from "./operations.types.js";

export class StubBafiProvider implements BafiProvider {
  private warn(method: string, clientId: string): BafiCheckResult {
    logger.warn({ method, clientId }, "Bafi not connected — returning stub result");
    return { found: false };
  }

  async checkForms(clientId: string): Promise<BafiCheckResult> {
    return this.warn("checkForms", clientId);
  }

  async checkReceipt(clientId: string): Promise<BafiCheckResult> {
    return this.warn("checkReceipt", clientId);
  }

  async checkPolicy(clientId: string): Promise<BafiCheckResult> {
    return this.warn("checkPolicy", clientId);
  }

  async checkDeposit(clientId: string): Promise<BafiCheckResult> {
    return this.warn("checkDeposit", clientId);
  }

  async crossCheck(clientId: string): Promise<BafiCheckResult> {
    return this.warn("crossCheck", clientId);
  }

  async getStaffList(): Promise<Array<{ id: string; name: string; phone?: string }>> {
    logger.warn({ method: "getStaffList" }, "Bafi not connected — returning empty staff list");
    return [];
  }
}

class SupabaseBafiProvider implements BafiProvider {
  async checkForms(clientId: string): Promise<BafiCheckResult> {
    try {
      const { count, error } = await supabaseAdmin
        .from("bafi_forms")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .limit(1);
      if (error) throw error;
      return { found: (count ?? 0) >= 1 };
    } catch (err) {
      logger.error({ method: "checkForms", clientId, err }, "SupabaseBafiProvider query failed");
      return { found: false };
    }
  }

  async checkReceipt(clientId: string): Promise<BafiCheckResult> {
    try {
      const [lifeResult, elemResult] = await Promise.all([
        supabaseAdmin
          .from("bafi_life_collection")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .limit(1),
        supabaseAdmin
          .from("bafi_elementary_collection")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId)
          .limit(1),
      ]);
      if (lifeResult.error) throw lifeResult.error;
      if (elemResult.error) throw elemResult.error;
      return { found: (lifeResult.count ?? 0) >= 1 || (elemResult.count ?? 0) >= 1 };
    } catch (err) {
      logger.error({ method: "checkReceipt", clientId, err }, "SupabaseBafiProvider query failed");
      return { found: false };
    }
  }

  async checkPolicy(clientId: string): Promise<BafiCheckResult> {
    try {
      const { count, error } = await supabaseAdmin
        .from("policies")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("status", "פעיל")
        .limit(1);
      if (error) throw error;
      return { found: (count ?? 0) >= 1 };
    } catch (err) {
      logger.error({ method: "checkPolicy", clientId, err }, "SupabaseBafiProvider query failed");
      return { found: false };
    }
  }

  async checkDeposit(clientId: string): Promise<BafiCheckResult> {
    try {
      const { count, error } = await supabaseAdmin
        .from("bafi_life_collection")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .not("last_deposit_amount", "is", null)
        .gt("last_deposit_amount", 0)
        .limit(1);
      if (error) throw error;
      return { found: (count ?? 0) >= 1 };
    } catch (err) {
      logger.error({ method: "checkDeposit", clientId, err }, "SupabaseBafiProvider query failed");
      return { found: false };
    }
  }

  async crossCheck(clientId: string): Promise<BafiCheckResult> {
    try {
      const [forms, receipt, policy, deposit] = await Promise.all([
        this.checkForms(clientId),
        this.checkReceipt(clientId),
        this.checkPolicy(clientId),
        this.checkDeposit(clientId),
      ]);
      const allPassed = forms.found && receipt.found && policy.found && deposit.found;
      return {
        found: allPassed,
        details: {
          forms: forms.found,
          receipt: receipt.found,
          policy: policy.found,
          deposit: deposit.found,
        },
      };
    } catch (err) {
      logger.error({ method: "crossCheck", clientId, err }, "SupabaseBafiProvider query failed");
      return { found: false };
    }
  }

  async getStaffList(): Promise<Array<{ id: string; name: string; phone?: string }>> {
    try {
      const { data, error } = await supabaseAdmin
        .from("staff")
        .select("id, full_name, phone")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id as string,
        name: row.full_name as string,
        phone: (row.phone as string | null) ?? undefined,
      }));
    } catch (err) {
      logger.error({ method: "getStaffList", err }, "SupabaseBafiProvider query failed");
      return [];
    }
  }
}

export const bafiProvider: BafiProvider =
  env.BAFI_PROVIDER === "stub" ? new StubBafiProvider() : new SupabaseBafiProvider();

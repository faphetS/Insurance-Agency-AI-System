import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";
import type { BafiCheckResult, BafiProvider } from "./operations.types.js";

class DefaultBafiProvider implements BafiProvider {
  private stub(method: string, clientId: string): BafiCheckResult {
    logger.warn({ method, clientId }, "Bafi not connected — returning stub result");
    return { found: false };
  }

  async checkForms(clientId: string): Promise<BafiCheckResult> {
    return this.stub("checkForms", clientId);
  }

  async checkReceipt(clientId: string): Promise<BafiCheckResult> {
    return this.stub("checkReceipt", clientId);
  }

  async checkPolicy(clientId: string): Promise<BafiCheckResult> {
    return this.stub("checkPolicy", clientId);
  }

  async checkDeposit(clientId: string): Promise<BafiCheckResult> {
    return this.stub("checkDeposit", clientId);
  }

  async crossCheck(clientId: string): Promise<BafiCheckResult> {
    return this.stub("crossCheck", clientId);
  }

  async getStaffList(): Promise<Array<{ id: string; name: string; phone?: string }>> {
    try {
      const { data, error } = await supabaseAdmin
        .from("staff")
        .select("id, full_name, phone")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []).map((row: any) => ({
        id: row.id as string,
        name: row.full_name as string,
        phone: (row.phone as string | null) ?? undefined,
      }));
    } catch (err) {
      logger.error({ method: "getStaffList", err }, "bafiProvider: staff query failed");
      return [];
    }
  }
}

export const bafiProvider: BafiProvider = new DefaultBafiProvider();

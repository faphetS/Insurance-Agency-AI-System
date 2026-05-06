import { logger } from "../../config/logger.js";
import type { BafiCheckResult, BafiProvider } from "./operations.types.js";

class StubBafiProvider implements BafiProvider {
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

export const bafiProvider: BafiProvider = new StubBafiProvider();

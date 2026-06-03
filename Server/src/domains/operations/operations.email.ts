import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { countUnreadEmails } from "../integrations/gmail/gmail.service.js";

export interface EmailAccountStatus {
  address: string;
  connected: boolean;
  pendingCount: number;
}

export interface EmailScanResult {
  accounts: EmailAccountStatus[];
  totalPending: number;
}

export interface EmailMonitoringSummary extends EmailScanResult {
  providerConnected: boolean;
}

const EMAIL_ADDRESSES = [
  "merav@shaked-ins.com",
  "hodaya@shaked-ins.com",
  "giti@shaked-ins.com",
  "rivka@shaked-ins.com",
  "tzivia@shaked-ins.com",
  "ruth@shaked-ins.com",
  "yafa@shaked-ins.com",
  "didi@shaked-ins.com",
];

export interface EmailProvider {
  scanAll(): Promise<EmailMonitoringSummary>;
}

export class StubEmailProvider implements EmailProvider {
  async scanAll(): Promise<EmailMonitoringSummary> {
    logger.warn({ method: "scanAll" }, "Email provider not connected — returning stub result");

    const accounts: EmailAccountStatus[] = EMAIL_ADDRESSES.map((address) => ({
      address,
      connected: false,
      pendingCount: 0,
    }));

    return {
      providerConnected: false,
      accounts,
      totalPending: 0,
    };
  }
}

export class GmailEmailProvider implements EmailProvider {
  async scanAll(): Promise<EmailMonitoringSummary> {
    const { data: integrations, error } = await supabaseAdmin
      .from("gmail_integrations")
      .select("staff_id, email, is_active")
      .eq("is_active", true);

    if (error) {
      logger.error({ error }, "GmailEmailProvider.scanAll: failed to query integrations");
      return { providerConnected: false, accounts: [], totalPending: 0 };
    }

    if (!integrations || integrations.length === 0) {
      return { providerConnected: false, accounts: [], totalPending: 0 };
    }

    const results = await Promise.allSettled(
      integrations.map(async (row: any) => {
        const staffId = row.staff_id as string;
        const address = row.email as string;

        try {
          const unreadCount = await countUnreadEmails(staffId);

          await supabaseAdmin
            .from("gmail_integrations")
            .update({
              last_unread_count: unreadCount,
              last_synced_at: new Date().toISOString(),
              last_error: null,
              updated_at: new Date().toISOString(),
            })
            .eq("staff_id", staffId);

          return { address, connected: true, pendingCount: unreadCount };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, staffId, address }, "GmailEmailProvider.scanAll: per-account error");

          await supabaseAdmin
            .from("gmail_integrations")
            .update({
              last_error: message,
              updated_at: new Date().toISOString(),
            })
            .eq("staff_id", staffId);

          return { address, connected: false, pendingCount: 0 };
        }
      }),
    );

    const accounts: EmailAccountStatus[] = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const address = (integrations[i]?.email as string | null) ?? "unknown";
      return { address, connected: false, pendingCount: 0 };
    });

    const totalPending = accounts.reduce((sum, a) => sum + a.pendingCount, 0);
    const anyConnected = accounts.some((a) => a.connected);

    return {
      providerConnected: anyConnected,
      accounts,
      totalPending,
    };
  }
}

export const emailProvider: EmailProvider =
  env.EMAIL_PROVIDER === "stub"
    ? new StubEmailProvider()
    : new GmailEmailProvider();

import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { scanCreds } from "../whatsapp/whatsapp.service.js";
import { scanDayUnanswered, type DayScanThread } from "./operations.whatsapp-scan.js";

export const WHATSAPP_NUMBERS = [
  { phone: "0559762838", label: "Health, Pension & Finance Dept", displayNumber: "055-976-2838" },
  { phone: "0533228285", label: "Property, Auto, Home & Business Dept", displayNumber: "053-322-8285" },
  { phone: "0547725826", label: "Didi", displayNumber: "054-772-5826" },
] as const;

export interface WhatsappNumberStatus {
  phone: string;
  label: string;
  displayNumber: string;
  connected: boolean;
  unansweredCount: number;
}

export interface WhatsappMonitoringSummary {
  providerConnected: boolean;
  numbers: WhatsappNumberStatus[];
  totalUnanswered: number;
}

export interface WhatsappMonitor {
  getSummary(): Promise<WhatsappMonitoringSummary>;
}

export class StubWhatsappMonitor implements WhatsappMonitor {
  async getSummary(): Promise<WhatsappMonitoringSummary> {
    logger.warn({ method: "getSummary" }, "WhatsApp monitor not connected — returning stub result");

    const numbers: WhatsappNumberStatus[] = WHATSAPP_NUMBERS.map((entry) => ({
      ...entry,
      connected: false,
      unansweredCount: 0,
    }));

    return {
      providerConnected: false,
      numbers,
      totalUnanswered: 0,
    };
  }
}

interface WhatsappInstance {
  id: string;
  label: string;
  phone_number: string;
  role: "bot" | "staff";
  purpose: "conversational" | "operational";
  staff_id: string | null;
  green_api_instance_id: string | null;
  green_api_token: string | null;
  green_api_url: string | null;
  is_active: boolean;
  is_connected: boolean;
  last_synced_at: string | null;
  last_unanswered_count: number | null;
  last_error: string | null;
}

let _scanNotConfiguredLogged = false;

async function greenApiUnansweredCount(_instance: WhatsappInstance): Promise<number> {
  const creds = scanCreds();
  if (!creds) {
    if (!_scanNotConfiguredLogged) {
      logger.info("greenApiUnansweredCount: scan instance not configured — returning 0");
      _scanNotConfiguredLogged = true;
    }
    return 0;
  }
  const result = await scanDayUnanswered(creds, {
    windowMinutes: 24 * 60,
    thresholdHours: env.GREENAPI_SCAN_UNANSWERED_HOURS,
  });
  return result.unansweredCount;
}

async function botUnansweredCount(): Promise<number> {
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: convRows, error } = await supabaseAdmin
    .from("conversations")
    .select("id")
    .not("client_id", "is", null)
    .lt("last_message_at", fifteenMinutesAgo);

  if (error) {
    logger.error({ error }, "botUnansweredCount: conversations query failed");
    return 0;
  }

  const convIds = (convRows ?? []).map((c: any) => c.id as string);
  if (convIds.length === 0) return 0;

  const { data: msgRows, error: msgError } = await supabaseAdmin
    .from("messages")
    .select("conversation_id, direction, created_at")
    .in("conversation_id", convIds)
    .order("created_at", { ascending: false });

  if (msgError) {
    logger.error({ error: msgError }, "botUnansweredCount: messages query failed");
    return 0;
  }

  const latestByConv = new Map<string, string>();
  for (const msg of msgRows ?? []) {
    const convId = msg.conversation_id as string;
    if (!latestByConv.has(convId)) {
      latestByConv.set(convId, msg.direction as string);
    }
  }

  let count = 0;
  for (const direction of latestByConv.values()) {
    if (direction === "inbound") count++;
  }
  return count;
}

export class GreenApiWhatsappMonitor implements WhatsappMonitor {
  async getSummary(): Promise<WhatsappMonitoringSummary> {
    const { data: instances, error } = await supabaseAdmin
      .from("whatsapp_instances")
      .select("*")
      .eq("is_active", true);

    if (error) {
      logger.error({ error }, "GreenApiWhatsappMonitor.getSummary: query failed");
      return { providerConnected: false, numbers: [], totalUnanswered: 0 };
    }

    if (!instances || instances.length === 0) {
      return { providerConnected: false, numbers: [], totalUnanswered: 0 };
    }

    const results = await Promise.allSettled(
      (instances as WhatsappInstance[]).map(async (instance) => {
        const base: WhatsappNumberStatus = {
          phone: instance.phone_number,
          label: instance.label,
          displayNumber: instance.phone_number,
          connected: false,
          unansweredCount: 0,
        };

        // Operational lines are "connected" when the scan creds are present in .env,
        // not when the DB row has green_api_instance_id filled (it doesn't need to be).
        const isConnected =
          instance.purpose === "operational" ? scanCreds() !== null : instance.is_connected;

        if (!isConnected) {
          return base;
        }

        try {
          let unansweredCount = 0;

          if (instance.purpose === "operational") {
            unansweredCount = await greenApiUnansweredCount(instance);
          } else {
            unansweredCount = await botUnansweredCount();
          }

          await supabaseAdmin
            .from("whatsapp_instances")
            .update({
              last_unanswered_count: unansweredCount,
              last_synced_at: new Date().toISOString(),
              last_error: null,
            })
            .eq("id", instance.id);

          return { ...base, connected: isConnected, unansweredCount };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, instanceId: instance.id }, "GreenApiWhatsappMonitor: per-instance error");

          await supabaseAdmin
            .from("whatsapp_instances")
            .update({ last_error: message })
            .eq("id", instance.id);

          return { ...base, connected: false, unansweredCount: 0 };
        }
      }),
    );

    const numbers: WhatsappNumberStatus[] = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const inst = (instances as WhatsappInstance[])[i]!;
      return {
        phone: inst.phone_number,
        label: inst.label,
        displayNumber: inst.phone_number,
        connected: false,
        unansweredCount: 0,
      };
    });

    const totalUnanswered = numbers.reduce((sum, n) => sum + n.unansweredCount, 0);
    const anyConnected = numbers.some((n) => n.connected);

    return {
      providerConnected: anyConnected,
      numbers,
      totalUnanswered,
    };
  }
}

export const whatsappMonitor: WhatsappMonitor =
  env.WHATSAPP_PROVIDER === "stub"
    ? new StubWhatsappMonitor()
    : new GreenApiWhatsappMonitor();

export async function greenApiUnansweredThreads(): Promise<DayScanThread[]> {
  const creds = scanCreds();
  if (!creds) return [];
  const r = await scanDayUnanswered(creds, { windowMinutes: 24 * 60, thresholdHours: env.GREENAPI_SCAN_UNANSWERED_HOURS });
  return r.unanswered;
}

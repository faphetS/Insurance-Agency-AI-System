import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../config/logger.js";

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

// TODO: Implement real GreenAPI chat history polling.
// Endpoint: GET https://${green_api_url}/waInstance${green_api_instance_id}/getChatHistory/${green_api_token}
// Returns array of messages; count those where fromMe=false and timestamp > threshold.
async function greenApiUnansweredCount(instance: WhatsappInstance): Promise<number> {
  logger.info(
    { instanceId: instance.green_api_instance_id, label: instance.label },
    "greenApiUnansweredCount: GreenAPI calls not implemented yet — returning 0",
  );
  return 0;
}

async function botUnansweredCount(): Promise<number> {
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // A conversation is unanswered when:
  // - the latest message is inbound (direction='inbound')
  // - it arrived more than 15 minutes ago
  // - there is no subsequent outbound reply in that conversation
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("id")
    .lt("last_message_at", fifteenMinutesAgo)
    .eq("last_message_direction", "inbound");

  if (error) {
    logger.error({ error }, "botUnansweredCount: query failed");
    return 0;
  }

  return data?.length ?? 0;
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

        if (!instance.is_connected) {
          return base;
        }

        try {
          let unansweredCount = 0;

          if (instance.role === "bot") {
            unansweredCount = await botUnansweredCount();
          } else {
            unansweredCount = await greenApiUnansweredCount(instance);
          }

          await supabaseAdmin
            .from("whatsapp_instances")
            .update({
              last_unanswered_count: unansweredCount,
              last_synced_at: new Date().toISOString(),
              last_error: null,
            })
            .eq("id", instance.id);

          return { ...base, connected: true, unansweredCount };
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
  process.env.WHATSAPP_PROVIDER === "stub"
    ? new StubWhatsappMonitor()
    : new GreenApiWhatsappMonitor();

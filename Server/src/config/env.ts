import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "staging", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  BACKEND_URL: z.string().url().default("http://localhost:3000"),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  // PostgreSQL (self-hosted)
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().default(10),

  // File storage
  STORAGE_DIR: z.string().default("./storage"),

  // Admin API
  ADMIN_API_TOKEN: z.string().min(16),

  // Auth
  JWT_SECRET: z.string().min(32),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900_000), // 15 minutes
  RATE_LIMIT_MAX: z.coerce.number().default(100),

  // Logging
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // CORS — comma-separated origins for multi-env support
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((val) => val.split(",").map((s) => s.trim())),

  // Conversational bot allowlist — comma-separated bare phone numbers.
  // Empty (default) means no restriction; only allowlisted senders trigger intake.
  REPLY_ALLOWLIST: z
    .string()
    .default("")
    .transform((v) => (v.trim() === "" ? [] : v.split(",").map((s) => s.trim()))),

  // Personal-line exclusion list — comma-separated phone numbers (local 05X or intl 972X)
  // exempt from ALL op-line automation: unanswered-WA auto-reply, commitment scan,
  // missed-call reminders. Owner's personal contacts.
  OP_EXCLUDED_PHONES: z
    .string()
    .default("")
    .transform((v) => (v.trim() === "" ? [] : v.split(",").map((s) => s.trim()))),

  // Shared inbound webhook auth for POST /api/whatsapp/webhook — used by the
  // operational (GREENAPI_OP_*) and NOTIFY (GREENAPI_NOTIFY_*) lines.
  GREENAPI_WEBHOOK_TOKEN: z.string().optional(),

  // Meta WhatsApp Cloud API — sole conversational transport (all blank keeps it dormant)
  META_VERIFY_TOKEN: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v24.0"),
  // WhatsApp Business Account id — used by the Chatwoot template-sync job to fetch approved templates.
  META_WABA_ID: z.string().optional(),

  // Chatwoot staff inbox — conversation mirror + human-takeover callback.
  // All blank keeps the mirror and the callback fully dormant.
  CHATWOOT_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, "") : v)),
  CHATWOOT_ACCOUNT_ID: z.string().optional(),
  CHATWOOT_INBOX_ID: z.string().optional(),
  CHATWOOT_BOT_TOKEN: z.string().optional(),
  CHATWOOT_BOT_USER_ID: z.string().optional(),
  CHATWOOT_CALLBACK_SECRET: z.string().optional(),
  // Administrator user token for the inbox PATCH that injects approved templates
  // (falls back to CHATWOOT_BOT_TOKEN — the mirror-bot user may lack admin rights).
  CHATWOOT_ADMIN_TOKEN: z.string().optional(),

  // GreenAPI instance #2: scanning / operational bot (leave blank until provisioned)
  GREENAPI_SCAN_ID_INSTANCE: z.string().optional(),
  GREENAPI_SCAN_API_TOKEN: z.string().optional(),
  GREENAPI_SCAN_BASE_URL: z.string().optional(),
  GREENAPI_SCAN_UNANSWERED_HOURS: z.coerce.number().min(0).default(4),

  // OpenRouter AI
  OPENROUTER_API_KEY: z.string().min(1),
  AI_MODEL: z.string().default("google/gemini-2.5-flash"),
  // Fallback model used when AI_MODEL fails (one retry before giving up); applies to text + image paths
  AI_FALLBACK_MODEL: z.string().default("google/gemini-3.1-pro-preview"),
  // AI model used for commitment extraction and composition (lighter model preferred)
  COMMITMENT_AI_MODEL: z.string().default("google/gemini-3.1-flash-lite"),

  // Google Calendar (OAuth 2.0)
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_CALENDAR_ID: z.string().min(1),
  GOOGLE_CALENDAR_BOOKING_URL: z.string().url(),

  // Google Workspace OAuth 2.0 (Sheets + Drive + Gmail — agency account)
  GOOGLE_WS_CLIENT_ID: z.string().optional(),
  GOOGLE_WS_CLIENT_SECRET: z.string().optional(),

  // Timeless.day (meeting recording + transcripts)
  TIMELESS_API_KEY: z.string().optional(),
  // The single WhatsApp number that receives the Hebrew meeting summary (owner line).
  SUMMARY_RECIPIENT_PHONE: z.string().optional(),

  // Google Workspace (Sheets + Drive lead mirror)
  LEADS_SPREADSHEET_ID: z
    .string()
    .default("11TwqEQzqh3Yul9dWQfX2s8__yfH0hbcI71f_TF1pAjw"),
  LEADS_SHEET_TAB: z.string().default("לידים חדשים"),
  LEADS_SHEET_TAB_NEW: z.string().default("לידים חדשים"),
  LEADS_SHEET_TAB_EXISTING: z.string().default("לקוח קיים"),
  // Tab names are trim-matched against the live sheet titles; F (relevance) drives the
  // 5-min relevance mover between these 3 tabs.
  LEADS_SHEET_TAB_IRRELEVANT: z.string().default("לא רלוונטי"),
  LEADS_DRIVE_FOLDER_ID: z
    .string()
    .default("1iwvNhMS2982JhzEemEJdq0-XQdqwGOXv"),
  // Disabled only when explicitly set to "false" (z.coerce.boolean treats any non-empty string as true).
  LEADS_MIRROR_ENABLED: z.string().default("true").transform((v) => v.trim().toLowerCase() !== "false"),

  // GreenAPI operational line — call events + daily missed/declined reminder
  GREENAPI_OP_BASE_URL: z.string().optional(),
  GREENAPI_OP_ID_INSTANCE: z.string().optional(),
  GREENAPI_OP_API_TOKEN: z.string().optional(),

  // Test-period toggle: when set (any non-empty value), isWithinOpWindow() bypasses the
  // whole Sun-Thu 09:00-18:00 Israel op window — digest, scan/LLM, timed reminders, call
  // reminders, and unanswered-WA all run regardless of day/time. Must be unset in production.
  UNANSWERED_WINDOW_DISABLED: z.string().optional(),

  // GreenAPI instance #3 — dedicated operational-notify line. Carries every owner
  // notification the operational bot sends (morning digest, call-reminder, commitments,
  // unanswered-WA alerts). Leave blank to keep dormant — notifyOwnerOps() no-ops.
  GREENAPI_NOTIFY_ID_INSTANCE: z.string().optional(),
  GREENAPI_NOTIFY_API_TOKEN: z.string().optional(),
  GREENAPI_NOTIFY_BASE_URL: z.string().optional(),

  // Provider toggles — set to "stub" to disable live API calls
  EMAIL_PROVIDER: z.enum(["stub", "live"]).default("live"),

  // Staff email notification mode for the daily sent-Gmail mention scan.
  // "log" = dry-run (compose to pm2 logs, no send); "send" = actually email staff.
  STAFF_EMAIL_NOTIFY_MODE: z.enum(["log", "send"]).default("log"),

  // Unanswered-WA watcher mode (the only feature sending FROM Didi's line 944). Auto-reply
  // is a single interactive-buttons message after 10 min of silence; a tap on "call me back"
  // is aggregated into one owner reminder at the next business day's 09:00 job (no immediate
  // notify; Fri/Sat roll to Sunday).
  // "off" = fully dormant (no tracking, no LLM, no sends); "log" = dry-run
  // (full pipeline, sends become log lines); "send" = real sends.
  UNANSWERED_WA_MODE: z.enum(["off", "log", "send"]).default("off"),

  // Welcome-image URL sent as a second bubble after the opening intake message.
  // Blank string disables the feature; unset falls back to <BACKEND_URL>/assets/brand.jpeg.
  WELCOME_IMAGE_URL: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Invalid environment variables:",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = parsed.data;

export type Env = z.infer<typeof envSchema>;

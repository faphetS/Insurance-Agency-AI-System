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

  // GreenAPI (WhatsApp gateway) — instance #1: conversational bot
  GREENAPI_ID_INSTANCE: z.string().min(1),
  GREENAPI_API_TOKEN: z.string().min(1),
  GREENAPI_BASE_URL: z.string().url(),
  GREENAPI_WEBHOOK_TOKEN: z.string().min(16),

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

  // Gmail OAuth 2.0 (for per-staff inbox monitoring)
  // Get credentials at: https://console.cloud.google.com/apis/credentials
  // Add Gmail API scopes: gmail.readonly + gmail.metadata
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:3000/api/integrations/gmail/callback"),

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
  LEADS_DRIVE_FOLDER_ID: z
    .string()
    .default("1iwvNhMS2982JhzEemEJdq0-XQdqwGOXv"),
  // Disabled only when explicitly set to "false" (z.coerce.boolean treats any non-empty string as true).
  LEADS_MIRROR_ENABLED: z.string().default("true").transform((v) => v.trim().toLowerCase() !== "false"),

  // Clix (WClixAPI) gateway — inbound webhook token (Milestone 1: receive & store)
  CLIX_WEBHOOK_TOKEN: z.string().min(16),

  // Clix outbound send API (Milestone 2: reply via Clix for Clix conversations)
  // Both must be set to enable Clix outbound; leave blank to keep dormant.
  CLIX_SEND_URL: z.string().url().optional(),
  CLIX_SEND_TOKEN: z.string().optional(),

  // Provider toggles — set to "stub" to disable live API calls
  EMAIL_PROVIDER: z.enum(["stub", "live"]).default("live"),
  WHATSAPP_PROVIDER: z.enum(["stub", "live"]).default("live"),
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

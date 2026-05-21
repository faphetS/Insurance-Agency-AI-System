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

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

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

  // GreenAPI (WhatsApp gateway)
  GREENAPI_ID_INSTANCE: z.string().min(1),
  GREENAPI_API_TOKEN: z.string().min(1),
  GREENAPI_BASE_URL: z.string().url(),
  GREENAPI_WEBHOOK_TOKEN: z.string().min(16),

  // OpenRouter AI
  OPENROUTER_API_KEY: z.string().min(1),
  AI_MODEL: z.string().default("google/gemini-3.1-pro-preview"),

  // Bafi (Insurance CRM) — optional until API access is resolved
  BAFI_API_URL: z.string().url().optional(),
  BAFI_API_TOKEN: z.string().optional(),
  BAFI_EXT_URL: z.string().url().optional(),

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

  // Timeless.day (meeting recording + transcripts)
  TIMELESS_API_KEY: z.string().optional(),
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

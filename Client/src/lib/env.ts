import { z } from "zod";

const envSchema = z.object({
  VITE_API_DOMAIN: z.string().url().default("http://localhost:3000"),
  VITE_SUPABASE_URL: z.string().url().optional(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  console.error(
    "[env] Invalid environment variables:",
    parsed.error.flatten().fieldErrors,
  );
}

const data = parsed.success ? parsed.data : envSchema.parse({});

export const env = {
  VITE_API_DOMAIN: data.VITE_API_DOMAIN,
  VITE_SUPABASE_URL: data.VITE_SUPABASE_URL ?? "",
  VITE_SUPABASE_ANON_KEY: data.VITE_SUPABASE_ANON_KEY ?? "",
};

if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
  console.warn(
    "[env] Supabase credentials missing — create a .env file from .env.sample",
  );
}

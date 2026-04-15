import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * Admin Supabase client — uses SERVICE_ROLE_KEY.
 * Bypasses RLS. Use for server-side operations where Express handles authorization.
 */
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

/**
 * Creates a per-request Supabase client that respects RLS.
 * Pass the user's JWT from the Authorization header.
 * Use when you want defense-in-depth (Express auth + RLS).
 */
export function createUserClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Verify Gmail OAuth setup uses the real Client ID and generates a valid URL.
// Run from Server/: npx tsx ../temp-files/verify-gmail-oauth.ts
import { env } from "../Server/src/config/env.js";
import { getAuthorizationUrl } from "../Server/src/domains/integrations/gmail/gmail.service.js";
import { supabaseAdmin } from "../Server/src/config/supabase.js";

async function run() {
  console.log("=== Env vars loaded ===");
  console.log(`CLIENT_ID set:     ${env.GOOGLE_OAUTH_CLIENT_ID ? "YES (" + env.GOOGLE_OAUTH_CLIENT_ID.slice(0, 20) + "…)" : "NO"}`);
  console.log(`CLIENT_SECRET set: ${env.GOOGLE_OAUTH_CLIENT_SECRET ? "YES" : "NO"}`);
  console.log(`REDIRECT_URI:      ${env.GOOGLE_OAUTH_REDIRECT_URI}`);

  console.log("\n=== Generate authorization URL for a real staff member ===");
  const { data: didi } = await supabaseAdmin
    .from("staff")
    .select("id, full_name, email")
    .eq("email", "didi@shaked-ins.com")
    .single();
  if (!didi) {
    console.log("Didi not found in staff table");
    return;
  }
  console.log(`Staff: ${didi.full_name} (${didi.id})`);

  const url = getAuthorizationUrl(didi.id);
  console.log("\nAuthorization URL:");
  console.log(url);
  console.log("\n=== URL components ===");
  const parsed = new URL(url);
  console.log(`Host:         ${parsed.host}`);
  console.log(`Path:         ${parsed.pathname}`);
  console.log(`client_id:    ${parsed.searchParams.get("client_id")?.slice(0, 30)}…`);
  console.log(`redirect_uri: ${parsed.searchParams.get("redirect_uri")}`);
  console.log(`response_type:${parsed.searchParams.get("response_type")}`);
  console.log(`scope:        ${parsed.searchParams.get("scope")}`);
  console.log(`access_type:  ${parsed.searchParams.get("access_type")}`);
  console.log(`prompt:       ${parsed.searchParams.get("prompt")}`);
  console.log(`state:        ${parsed.searchParams.get("state")} (should match Didi's UUID)`);

  const validHost = parsed.host === "accounts.google.com";
  const validClientId = parsed.searchParams.get("client_id") === env.GOOGLE_OAUTH_CLIENT_ID;
  const validRedirect = parsed.searchParams.get("redirect_uri") === env.GOOGLE_OAUTH_REDIRECT_URI;
  const stateMatchesStaff = parsed.searchParams.get("state") === didi.id;

  console.log("\n=== Validation ===");
  console.log(`  ${validHost ? "✓" : "✗"} Hosted at accounts.google.com`);
  console.log(`  ${validClientId ? "✓" : "✗"} client_id matches env`);
  console.log(`  ${validRedirect ? "✓" : "✗"} redirect_uri matches env`);
  console.log(`  ${stateMatchesStaff ? "✓" : "✗"} state = Didi's staff UUID`);

  if (validHost && validClientId && validRedirect && stateMatchesStaff) {
    console.log("\nALL VALID — open the URL above in a browser to complete the OAuth flow");
  } else {
    console.log("\nVALIDATION FAILED");
  }
}

run().then(() => process.exit(0)).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

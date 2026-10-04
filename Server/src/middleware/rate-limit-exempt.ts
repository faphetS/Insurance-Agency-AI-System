// Inbound webhooks authenticate themselves (Meta HMAC, GreenAPI token, Chatwoot path
// secret, Zadarma IP gate) and arrive in bursts from a single IP — Chatwoot from
// localhost, Meta's status pings — so they bypass the per-IP /api limiter.
// Paths are relative to the /api mount; a trailing "/" means prefix match.
const EXEMPT = ["/whatsapp/webhook", "/whatsapp/meta-webhook", "/chatwoot/callback/", "/zadarma/call-webhook"];

export function isRateLimitExempt(path: string): boolean {
  return EXEMPT.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

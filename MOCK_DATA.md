# Mock Data & Simulation Contract

**Status as of 2026-05-19:** Several external integrations are simulated, not real. Every piece of data described below is **fake test data**, not actual customer or agency records.

When the real APIs come online, the simulation providers get swapped for real ones — schema, checker logic, and UI do not change.

---

## What is simulated

### 1. BAFI CRM → Supabase mirror

BAFI is the agency's real-world CRM (`https://ext.bafi.co.il`). We do not yet have API access.

Until then, the following Supabase tables act as a **local mirror** of BAFI's data structure (sourced from live UI exploration documented in [bafi-reference.md](bafi-reference.md)):

| Supabase table | Mirrors BAFI section |
|---|---|
| `clients` (extended cols: `bafi_file_number`, `id_number`, `gender`, `id_issue_date`, `passport_number`, `health_fund`, `poa_signed`, `client_type`, `agency_group`, `assigned_handler_id`, `address`, `workplace`, `referring_party`) | לקוחות — Client list & card |
| `insurance_companies` | חברות ביטוח (referenced in policies/forms) |
| `employers` | מעסיקים |
| `bafi_agents` | סוכנים |
| `contacts` | קשרים (client relations) |
| `policies` | פוליסות ותוכניות |
| `claims` | תביעות |
| `bafi_forms` | טפסים |
| `bafi_life_collection` | גבייה חיים |
| `bafi_elementary_collection` | גביה אלמנטרי |
| `bafi_documents` | מסמכים |

All seeded rows are invented for testing. The one realistic client (`ברקו שי` / Barko Shay) uses policy numbers and structure observed in the BAFI UI on 2026-05-15 but the values are fabricated.

**Provider swap target:** [Server/src/domains/operations/operations.bafi.ts](Server/src/domains/operations/operations.bafi.ts) — `SupabaseBafiProvider` reads the tables above. When BAFI API access is granted, build a `BafiApiProvider` implementing the same `BafiProvider` interface; the mock tables can be dropped or repurposed as a cache.

### 2. Gmail → one Gmail simulates 8 staff inboxes

The agency has 8 staff members (Didi, Yafa, Tzivia, Ruth, Giti, Merav, Hodaya, Rivka — see [bafi-reference.md](bafi-reference.md) line 294).

During simulation, the developer's single Gmail account (`clixteam579@gmail.com`) stands in for **all 8 inboxes**. The Email Scanning feature ([Server/src/domains/operations/operations.email.ts](Server/src/domains/operations/operations.email.ts)) will be wired to that one account, with each staff record in the `staff` table aliased to the same underlying inbox.

**Provider swap target:** `StubEmailProvider` → `GmailProvider` (single account, multi-alias). Real deployment requires either 8 separate OAuth flows OR Google Workspace domain-wide delegation (1 service account → 8 mailboxes) — domain-wide delegation strongly preferred.

### 3. WhatsApp → developer's number simulates the agency line

The agency runs 4 WhatsApp lines (1 bot + 3 staff). During simulation, the developer's WhatsApp number is treated as the **main agency bot line**. WhatsApp Monitoring ([Server/src/domains/operations/operations.whatsapp-monitor.ts](Server/src/domains/operations/operations.whatsapp-monitor.ts)) will only watch this one number.

**Provider swap target:** `StubWhatsappMonitor` → `GreenApiMonitor` against 4 GreenAPI instances when the agency provisions them.

---

## What is real (not simulated)

- WhatsApp Client Agent (Component A) — full intake flow, OCR validation, calendar booking, auto-pause on human takeover
- Operational Assistant scaffold (Component B) — task chains, scheduler, notifications, SLA checks all run for real; they just had no data to check against until the BAFI mirror was seeded
- Google Calendar integration — real OAuth, real events, real two-way sync
- Supabase database, auth, RLS — all real

---

## Mock-only migrations (safe to roll back together)

These migrations exist purely to enable simulation. When real BAFI API integration replaces them, they can be dropped:

- `20260519100000_bafi_extend_clients.sql`
- `20260519100100_bafi_reference_tables.sql`
- `20260519100200_bafi_policies_claims.sql`
- `20260519100300_bafi_forms_collection.sql`
- `20260519100400_bafi_documents.sql`
- `20260519100500_seed_bafi_staff.sql`
- `20260519100600_seed_bafi_sample_data.sql`

---

## Before deployment checklist

- [ ] Real BAFI API access (replace `SupabaseBafiProvider` with `BafiApiProvider`)
- [ ] 4× GreenAPI instances (1 bot + 3 staff)
- [ ] Gmail access for 8 staff — prefer Google Workspace domain-wide delegation over 8 separate OAuth flows
- [ ] Drop mock-only migrations OR convert them into a sync cache
- [ ] Replace seeded test clients with a real BAFI export

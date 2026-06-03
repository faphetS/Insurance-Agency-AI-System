# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Insurance Agency AI System** — a TypeScript **Node/Express backend** for an insurance agency with AI capabilities, backed by **self-hosted PostgreSQL on the Hostinger VPS**.

- Customer-facing UX lives in **WhatsApp** (Component A — the conversational intake bot).
- Staff-facing UX is **WhatsApp / email notifications**, not a web UI.
- There is **no frontend** anymore. A throwaway React inspector app once lived under `Client/`; it was deleted during the Postgres migration (2026-06-03).

> **Migration note (2026-06-03):** the backend was moved OFF Supabase onto self-hosted Postgres. Some details below changed accordingly. See **Historical context** at the bottom for the old Supabase + duplicated-BAFI setup, which is intentionally preserved as a record.

## Temp Files

The `temp-files/` folder at the project root is a scratch space for generated artifacts that aren't part of the codebase — screenshots, debug output, schema dumps, etc. Use it freely. The user may delete its contents at any time.

## Custom Subagents — Auto-Invoke Rule

Three custom subagents live in `.claude/agents/`. Each wraps the relevant installed skill(s). When a task matches a subagent's domain, delegate to it via the Agent tool — do not do the work yourself, and do not just invoke the skill directly.

- **Postgres / database / SQL / schema / migrations** → `supabase-expert` subagent (wraps the `supabase` skill — still the best DB/Postgres skill even though Supabase itself is gone)
- **Express / Node.js / backend / API routes / middleware / controllers / services / validators** → `backend-expert` subagent (wraps `nodejs-backend-typescript`)
- **React / frontend / UI** → `frontend-expert` subagent — currently no frontend exists, so rarely applicable

For tasks spanning multiple domains, spawn multiple subagents in parallel (single message, multiple Agent calls) when their work is independent.

## Commands

There is **no root `package.json`** (the old npm-workspaces monorepo is gone). Work inside `Server/`.

### Server (from `Server/`)
- `npm run dev` — Start with nodemon + tsx (http://localhost:3000)
- `npm run build` — Compile TypeScript to `dist/`
- `npm start` — Run compiled `dist/server.js`
- `npm run test` — Vitest
- `npm run typecheck` — tsc --noEmit
- `npm run lint` — ESLint

## Architecture

### Server (`Server/`)
- **Entry:** `src/server.ts` — Express 5 with a production middleware stack.
- **Config:** `src/config/` — env (Zod-validated), the **pg pool + Supabase-compatibility shim**, Pino logger.
- **Middleware:** `src/middleware/` — requestId, auth (static admin token + role gate), validate (Zod), audit logging.
- **Domains:** `src/domains/`:
  - `ai/` — conversational bot: `intake.orchestrator.ts` (WhatsApp intake state machine), `ai.orchestrator.ts` (auto-reply), `ai.service.ts` (OpenRouter LLM).
  - `whatsapp/` — inbound webhook, message/conversation handling, sending (GreenAPI), escalation, unanswered-scan.
  - `calendar/` — Google Calendar OAuth, booking sync (event→client matching, meeting creation), 24h/1h reminders.
  - `operations/` — the operational assistant: task-chain checkers, daily digest, alerts, BAFI provider (stubbed), service-meeting + email + whatsapp monitors.
  - `integrations/gmail`, `integrations/timeless` — per-staff Gmail OAuth; Timeless.day meeting recordings.
- **Routes:** `src/routes/index.ts` — aggregates domain routes, mounted at `/api`. A signed `/files/*splat` route (outside `/api`) serves stored documents.
- **Lib:** `src/lib/db.ts` (pg pool + query-builder shim), `src/lib/storage.ts` (filesystem document storage), `src/lib/errors.ts` (AppError hierarchy + global error handler).

### Middleware Stack (order matters)
1. Request ID → 2. CORS → 3. Helmet (CSP/HSTS) → 4. Pino HTTP logger → 5. Body parsing (1MB) → 6. Cookie parser → 7. HPP → 8. Rate limiting on `/api` → 9. Audit logging (mutations only) → 10. Routes → 11. 404 → 12. Global error handler.

### Database (self-hosted PostgreSQL)
- **Where:** PostgreSQL 17 on the Hostinger VPS, `localhost:5432`, database `insurance`, role `app`.
- **Access from Express:** `src/lib/db.ts` exposes `supabaseAdmin` — a **compatibility shim** with a supabase-js-style `.from(table).select().eq()...` API (returns `{ data, error, count }`, builder is awaitable) backed by `pg`. `config/supabase.ts` re-exports it, so existing call sites are unchanged. It also exports the raw `pool` for hand-written SQL (used in one join in `booking-sync.service.ts`).
- **Schema:** `db/schema.sql` — single consolidated plain-Postgres schema (no RLS). Apply with `psql -U app -d insurance -f db/schema.sql`.
- **No ORM, no edge functions, no RLS.** Authorization is enforced in Express middleware.

### Auth
- A single static **`ADMIN_API_TOKEN`** (bearer) protects admin/ops endpoints (`authenticate` in `middleware/auth.ts`). There is no user login / no Supabase Auth / no RLS.
- The WhatsApp webhook authenticates with its own GreenAPI token, independent of the admin token.

### Environment Variables (`Server/.env`)
- Core: `NODE_ENV`, `PORT`, `BACKEND_URL`, `FRONTEND_URL`, `ALLOWED_ORIGINS`, `RATE_LIMIT_*`, `LOG_LEVEL`.
- DB / auth / storage: `DATABASE_URL`, `DATABASE_POOL_MAX`, `ADMIN_API_TOKEN`, `STORAGE_DIR`, `JWT_SECRET` (HMAC key for signed `/files` URLs).
- Integrations: `GREENAPI_*`, `OPENROUTER_API_KEY` + `AI_MODEL`, `GOOGLE_*` (Calendar) + `GOOGLE_OAUTH_*` (Gmail), `TIMELESS_API_KEY`, `BAFI_*`.
- Provider toggles: `BAFI_PROVIDER` (default `stub`), `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER`.
- `.env.sample` lists all keys; `.env` is gitignored.

## Key Conventions
- ES modules throughout (`"type": "module"`); ESM import suffixes are `.js`.
- TypeScript strict mode.
- DB access: use `supabaseAdmin` (the shim) from `./config/supabase.js`, or `pool` from `./lib/db.js` for raw SQL — never create new pools/clients.
- Server env: use `env` from `./config/env.js`, never raw `process.env`.
- Logging: use `logger` from `./config/logger.js`, never `console.log`.
- Errors: throw `AppError` subclasses, never generic `Error`.
- New domains: create `src/domains/{name}/` with controller, service, routes, validator.
- Auth: `authenticate` checks the static token; `authorize(...roles)` gates by role (always `admin` now).
- Validation: `validate({ body?, params?, query? })` with Zod. **Express 5 note:** `req.query`/`req.params` are getter-only — the middleware uses `Object.defineProperty`; route wildcards must be named (`/*splat`, not `/*`).

## Deployment
- **VPS:** `srv1622531` / `187.127.224.73`, code at `/opt/app`, run by PM2 as `insurance-api` (node via nvm). Public base `https://srv1622531.hstgr.cloud` (reverse-proxied to `:3000`).
- **Deploy:** `.github/workflows/deploy-vps.yml` — on push to `main` touching `Server/**`: SSH → `git pull` → `npm install` → `npm run build` → `pm2 restart insurance-api`. Postgres + `.env` live on the VPS (not in the deploy).
- **CI:** `.github/workflows/ci.yml` — Server-only: lint → typecheck → test → build.

## Testing
- **Framework:** Vitest (node environment); supertest available for integration tests.
- Test files: `*.test.ts` colocated next to source.

## Historical context — Supabase & the duplicated BAFI structure (preserved as a record)

Until 2026-06-03 the backend ran on **Supabase** (project `jioxislibtqmesgribkg`, ap-northeast-1, Postgres 17): managed Postgres + Auth (GoTrue) + Storage + RLS (69 policies). The migration replaced all of that with self-hosted Postgres, a static admin token, and filesystem storage. Old migrations remain in `supabase/migrations/` for reference; applying new migrations there is obsolete.

A **duplicated mirror of the BAFI CRM** was modeled directly in the database — a *mock* mirror (there was no live BAFI API), seeded with sample data for development. It was **dropped** during the migration (not ported). The dropped objects were:

- **Tables:** `bafi_forms`, `bafi_life_collection`, `bafi_elementary_collection`, `policies`, `claims`, `insurance_companies`, `employers`, `bafi_agents`, `contacts`, `bafi_documents`.
- **Columns on `clients`:** `bafi_file_number`, `id_number`, `date_of_birth`, `gender`, `id_issue_date`, `passport_number`, `health_fund`, `poa_signed`, `client_type`, `agency_group`, `address`, `workplace`, `referring_party`. (`assigned_handler_id`/`assigned_to` were **kept** — staff routing.)

The conversational bot never wrote to any of these; only the operational layer read them (staff-handoff display + the BAFI milestone checks, now stubbed via `BAFI_PROVIDER=stub`). Full detail lives in `bafi-reference.md` and `MOCK_DATA.md` (repo root) and in git history (`supabase/migrations/20260519*`). When the real BAFI API arrives, rebuild only what's needed from that reference rather than restoring the mock mirror.

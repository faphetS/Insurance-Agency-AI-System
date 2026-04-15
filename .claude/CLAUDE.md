# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Insurance Agency AI System** — Fullstack TypeScript application for an insurance agency with AI capabilities. React frontend + Node/Express backend + Supabase PostgreSQL database.

## Temp Files

The `temp-files/` folder at the project root is a scratch space for generated artifacts that aren't part of the codebase — screenshots, downloaded edge functions, debug output, schema dumps, etc. Use it freely. The user may delete its contents at any time.

## Custom Subagents — Auto-Invoke Rule

Three custom subagents live in `.claude/agents/`. Each one wraps the relevant installed skill(s). When a task matches a subagent's domain, delegate to it via the Agent tool — do not do the work yourself, and do not just invoke the skill directly.

- **Supabase / database / Postgres / RLS / migrations / tables / schema** → `supabase-expert` subagent (wraps `supabase` skill)
- **Express / Node.js / backend / API routes / middleware / controllers / services / validators** → `backend-expert` subagent (wraps `nodejs-backend-typescript` skill)
- **React / frontend / components / hooks / pages / UI logic** → `frontend-expert` subagent (wraps BOTH `vercel-react-best-practices` and `frontend-design` skills)

For full-stack tasks that span multiple domains, spawn multiple subagents in parallel (single message, multiple Agent tool calls) when their work is independent. Each subagent reads its own skill(s) before starting.

Skills are installed locally in `.claude/.agents/skills/` and symlinked from `.claude/skills/`.

## Commands

### Root (monorepo)
- `npm run dev` — Start both client and server concurrently
- `npm run build` — Build both
- `npm run test` — Test both
- `npm run lint` — Lint both
- `npm run typecheck` — Typecheck both

### Client (from `Client/`)
- `npm run dev` — Start Vite dev server (http://localhost:5173)
- `npm run build` — TypeScript check + Vite production build
- `npm run lint` — ESLint
- `npm run test` — Vitest
- `npm run typecheck` — tsc -b --noEmit

### Server (from `Server/`)
- `npm run dev` — Start with nodemon + tsx (http://localhost:3000)
- `npm run build` — Compile TypeScript to `dist/`
- `npm start` — Run compiled `dist/server.js`
- `npm run test` — Vitest
- `npm run typecheck` — tsc --noEmit

Root `package.json` uses npm workspaces (`Client/`, `Server/`). Run `npm install` from root.

## Architecture

### Client (`Client/`)
- **Entry:** `src/main.tsx` → mounts app inside `<QueryClientProvider>`, `<Suspense>`, `<ErrorBoundary>`, `<StrictMode>`
- **Routing:** `src/app/router.tsx` — `createBrowserRouter` with lazy-loaded routes
- **Layout:** `src/app/App.tsx` — root layout with `<Outlet>` + `<Toaster>`
- **Pages:** `src/pages/` — page-level components (HomePage, NotFoundPage)
- **Features:** `src/features/` — domain feature modules (auth, dashboard, policies, etc.)
- **Components:** `src/components/` — shared UI (ErrorBoundary, Card)
- **Services:** `src/services/api.ts` — Axios instance with auth interceptor (attaches JWT, redirects on 401)
- **Lib:** `src/lib/` — env validation, React Query client, Supabase client
- **Stores:** `src/stores/auth.store.ts` — Zustand auth state (user, token, loading)
- **Hooks:** `src/hooks/` — shared custom React hooks
- **Types:** `src/types/` — shared TypeScript types
- **Styling:** Tailwind CSS 4.x via `@tailwindcss/vite` plugin
- **Path aliases:** `@/*` maps to `./src/*`

### Server (`Server/`)
- **Entry:** `src/server.ts` — Express 5 with production middleware stack
- **Config:** `src/config/` — env (Zod-validated), Supabase clients, Pino logger
- **Middleware:** `src/middleware/` — requestId, auth (JWT + RBAC), validate (Zod), audit logging
- **Domains:** `src/domains/` — domain-driven modules:
  - `auth/` — controller, service, routes, validator (wired)
  - `policies/`, `claims/`, `customers/`, `agents/`, `ai/` — scaffolded, not yet implemented
- **Routes:** `src/routes/index.ts` — aggregates domain routes, mounted at `/api`
- **Lib:** `src/lib/errors.ts` — AppError class hierarchy + global error handler
- **Types:** `src/types/` — shared types, generated DB types (future)

### Middleware Stack (order matters)
1. Request ID (UUID per request)
2. CORS (multi-origin via `ALLOWED_ORIGINS`)
3. Helmet (strict CSP, HSTS)
4. Pino HTTP logger
5. Body parsing (JSON + URL-encoded, 1MB limit)
6. Cookie parser
7. HPP (HTTP parameter pollution)
8. Rate limiting on `/api`
9. Audit logging (mutations only)
10. Routes
11. 404 handler
12. Global error handler

### Database (Supabase)
- **Project:** `jioxislibtqmesgribkg` (ap-northeast-1, Postgres 17)
- **Access from Express:** Two Supabase clients in `Server/src/config/supabase.ts`:
  - `supabaseAdmin` — service role key, bypasses RLS (for server-side admin operations)
  - `createUserClient(token)` — per-request client respecting RLS
- **No edge functions** — Express handles all API logic
- **Schema:** Currently empty (brand new project)

### Client-Server Connection
- Vite proxies `/api/*` requests to `VITE_API_DOMAIN` (default `http://localhost:3000`)
- Server CORS allows `ALLOWED_ORIGINS` env var origins
- Auth: JWT in Authorization header, attached automatically by Axios interceptor

### Environment Variables
- **Client/.env:** `VITE_API_DOMAIN`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- **Server/.env:** `NODE_ENV`, `PORT`, `BACKEND_URL`, `FRONTEND_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `RATE_LIMIT_*`, `LOG_LEVEL`, `ALLOWED_ORIGINS`
- Both have `.env.sample` files with all required keys
- `.env` files are gitignored

## Key Conventions
- ES modules throughout (`"type": "module"`)
- TypeScript strict mode in all tsconfig files
- ESLint flat config (9 client, 10 server)
- Prettier config at project root
- Path aliases: use `@/` for all Client imports
- API calls: use `@/services/api` Axios instance, never raw axios
- Server env: use `env` from `./config/env.js`, never raw `process.env`
- Supabase: use clients from `./config/supabase.js`, never create new clients
- Logging: use `logger` from `./config/logger.js`, never `console.log`
- Errors: throw `AppError` subclasses, never generic `Error`
- New domains: create `src/domains/{name}/` with controller, service, routes, validator files
- Auth: `authenticate` middleware verifies JWT, `authorize(...roles)` checks RBAC
- Validation: use `validate({ body?, params?, query? })` middleware with Zod schemas

## Testing
- **Framework:** Vitest (both client and server)
- **Client:** jsdom environment, `@testing-library/react`, setup in `src/test/setup.ts`
- **Server:** node environment, supertest available for integration tests
- Test files: `*.test.ts` / `*.test.tsx` colocated next to source files

## CI/CD
- GitHub Actions at `.github/workflows/ci.yml`
- Pipeline: lint → typecheck → test → build
- Runs on push/PR to main

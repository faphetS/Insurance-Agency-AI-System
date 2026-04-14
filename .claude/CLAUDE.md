# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Fullstack boilerplate: React (Vite) frontend + Node/Express backend, both in TypeScript. No database or state management is configured yet — these are left as extension points.

## Commands

### Client (from `Client/`)
- `npm run dev` — Start Vite dev server (http://localhost:5173)
- `npm run build` — TypeScript check + Vite production build
- `npm run lint` — ESLint
- `npm run preview` — Preview production build

### Server (from `Server/`)
- `npm run dev` — Start with nodemon + tsx (http://localhost:3000)
- `npm run build` — Compile TypeScript to `dist/`
- `npm start` — Run compiled `dist/server.js`

Both Client and Server require separate `npm install`. There is no root package.json.

## Architecture

### Client (`Client/`)
- **Entry:** `src/main.tsx` → mounts `<App>` inside `<ErrorBoundary>`, `<BrowserRouter>`, and `<StrictMode>`
- **Routing:** React Router v7 in `src/App.tsx` — add new routes here
- **Pages:** `src/pages/` — page-level components
- **Components:** `src/components/` — reusable UI (includes `ErrorBoundary`)
- **Services:** `src/services/api.ts` — centralized Axios instance with `/api` base URL and error interceptor
- **Hooks:** `src/hooks/` — custom React hooks
- **Types:** `src/types/` — TypeScript interfaces and type definitions
- **Utils:** `src/utils/` — helper functions and constants
- **State management:** `src/store/` — placeholder directory, no library installed yet
- **Styling:** Tailwind CSS 4.x via `@tailwindcss/vite` plugin
- **Path aliases:** `@/*` maps to `./src/*` (configured in tsconfig.app.json + vite.config.ts)

### Server (`Server/`)
- **Entry:** `src/server.ts` — Express app with helmet, CORS, error handler
- **Env validation:** `src/config/env.ts` — Zod schema validates `PORT`, `BACKEND_URL`, `FRONTEND_URL` on startup
- **Routes:** `src/routes/index.ts` aggregates all route modules, mounted at `/api`
- **Controllers:** `src/controllers/` — route handlers (MVC pattern)
- **Middleware:** `src/middleware/` — Express middleware (auth, validation, etc.)
- **Services:** `src/services/` — business logic layer
- **Validators:** `src/validators/` — Zod schemas for request validation
- **Models:** `src/models/` — database models and schemas
- **Types:** `src/types/` — TypeScript interfaces and type definitions
- **Utils:** `src/utils/` — helper functions and constants
- **Health checks:** `GET /` and `GET /health` on the server root

### Client-Server Connection
- Vite proxies `/api/*` requests to `VITE_API_DOMAIN` (default `http://localhost:3000`) configured in `Client/vite.config.ts`
- Server CORS allows `FRONTEND_URL` env var as origin
- In production, proxy is not used — deploy behind same domain or update CORS accordingly

### Environment Variables
- **Client/.env:** `VITE_API_DOMAIN` (backend URL for Vite proxy)
- **Server/.env:** `PORT`, `BACKEND_URL`, `FRONTEND_URL` — validated by Zod on startup via `src/config/env.ts`
- Sample `.env.sample` files exist in both directories

## Key Conventions
- ES modules throughout (`"type": "module"` in both package.json files)
- Express 5.x on the backend with Helmet security headers
- TypeScript strict mode enabled in all tsconfig files
- ESLint 9 flat config format (Client), ESLint 10 (Server)
- Prettier config at project root (`.prettierrc`)
- Path aliases: use `@/` for all Client imports (e.g., `import api from "@/services/api"`)
- API calls: use the centralized `@/services/api` Axios instance, not raw `axios`
- Server env: use `env` from `./config/env.js`, not raw `process.env`
- Add new API routes by creating a route file in `Server/src/routes/`, a controller in `Server/src/controllers/`, and registering in `Server/src/routes/index.ts`

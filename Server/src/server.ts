import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { setWebhookSettings } from "./domains/whatsapp/whatsapp.service.js";
import { syncNewBookings } from "./domains/calendar/booking-sync.service.js";
import { checkAndSendReminders } from "./domains/calendar/reminder.service.js";
import helmet from "helmet";
import hpp from "hpp";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Options, HttpLogger } from "pino-http";
import pinoHttpImport from "pino-http";
const pinoHttp = pinoHttpImport as unknown as (opts?: Options) => HttpLogger<IncomingMessage, ServerResponse>;
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { AppError, globalErrorHandler } from "./lib/errors.js";
import { audit } from "./middleware/audit.js";
import { requestId } from "./middleware/requestId.js";
import apiRoutes from "./routes/index.js";
import rateLimit from "express-rate-limit";

const app = express();

// Trust the first reverse proxy (Render / Vercel) so req.ip + rate-limit key work.
app.set("trust proxy", 1);

// --- Middleware stack (order matters) ---

// 1. Request ID — trace every request
app.use(requestId);

// 2. CORS — must be before helmet to handle preflight correctly
app.use(
  cors({
    origin: env.ALLOWED_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// 3. Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", env.SUPABASE_URL],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }),
);

// 4. Structured logging
app.use(
  pinoHttp({
    logger,
    customProps: (req) => ({ requestId: (req as unknown as Request).id }),
    autoLogging: { ignore: (req) => req.url === "/health" },
  }),
);

// 5. Body parsing with size limits
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// 6. Cookie parsing
app.use(cookieParser());

// 7. HTTP parameter pollution protection
app.use(hpp());

// 8. Rate limiting
app.use(
  "/api",
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: "error", code: "RATE_LIMITED", message: "Too many requests" },
  }),
);

// 9. Audit logging for mutations
app.use(audit);

// --- Routes ---

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api", apiRoutes);

// --- 404 handler for unmatched routes ---
app.use((_req: Request, _res: Response) => {
  throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
});

// --- Global error handler (must be last) ---
app.use(globalErrorHandler);

// --- Graceful shutdown ---
const server = app.listen(env.PORT, () => {
  logger.info(`Server running on ${env.BACKEND_URL} [${env.NODE_ENV}]`);

  // Register GreenAPI webhook on boot (best-effort, non-blocking)
  if (env.BACKEND_URL) {
    const webhookUrl = `${env.BACKEND_URL}/api/whatsapp/webhook`;
    setWebhookSettings(webhookUrl)
      .then(() => logger.info({ webhookUrl }, "GreenAPI webhook registered"))
      .catch((err: unknown) =>
        logger.warn({ err, webhookUrl }, "GreenAPI webhook registration failed — continuing"),
      );
  }

  // Calendar sync: initial run after 30s, then every 5 minutes
  setTimeout(() => {
    syncNewBookings().catch((err: unknown) =>
      logger.error({ err }, "booking-sync: initial run failed"),
    );
  }, 30_000);
  setInterval(() => {
    syncNewBookings().catch((err: unknown) =>
      logger.error({ err }, "booking-sync: scheduled run failed"),
    );
  }, 5 * 60 * 1000);

  // Reminder check: every 15 minutes
  setInterval(() => {
    checkAndSendReminders().catch((err: unknown) =>
      logger.error({ err }, "reminder: scheduled check failed"),
    );
  }, 15 * 60 * 1000);
});

function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });

  // Force exit after 10s if connections won't close
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

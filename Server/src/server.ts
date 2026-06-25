import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { setWebhookSettings } from "./domains/whatsapp/whatsapp.service.js";
import { ensureClientDocumentsBucket } from "./lib/storage.js";
import { ensureWebhookRegistered } from "./domains/integrations/timeless/timeless.service.js";
import { startTimelessPollCron } from "./domains/integrations/timeless/timeless.poll.js";
import { startCommitmentCrons } from "./domains/commitments/commitments.service.js";
import { syncNewBookings } from "./domains/calendar/booking-sync.service.js";
import { checkAndSendReminders } from "./domains/calendar/reminder.service.js";
import { checkServiceMeetingEligibility } from "./domains/calendar/service-meeting.service.js";
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
import filesRouter from "./domains/files/files.routes.js";
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
        connectSrc: ["'self'"],
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

// 5. Body parsing with size limits.
// The Clix webhook delivers media as inline base64 — give that path 20 MB.
// All other routes keep the 1 MB guard. Both parsers use the same rawBody
// capture so existing rawBody consumers are unaffected.
const captureRawBody = (req: IncomingMessage, _res: ServerResponse, buf: Buffer): void => {
  (req as unknown as { rawBody?: Buffer }).rawBody = buf;
};
app.use("/api/whatsapp/webhook", express.json({ limit: "20mb", verify: captureRawBody }));
app.use(express.json({ limit: "1mb", verify: captureRawBody }));
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
app.use("/files", filesRouter);

// --- 404 handler for unmatched routes ---
app.use((_req: Request, _res: Response) => {
  throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
});

// --- Global error handler (must be last) ---
app.use(globalErrorHandler);

// --- Graceful shutdown ---
const server = app.listen(env.PORT, () => {
  logger.info(`Server running on ${env.BACKEND_URL} [${env.NODE_ENV}]`);

  // Ensure Supabase Storage bucket for client documents exists (best-effort, unconditional).
  ensureClientDocumentsBucket()
    .then((created) => logger.info({ created }, "client-documents bucket ready"))
    .catch((err: unknown) => logger.warn({ err }, "client-documents bucket ensure failed"));

  // Register GreenAPI webhook on boot (best-effort, non-blocking).
  // Guarded: only runs when BACKEND_URL is a public HTTPS URL. Dev / localhost
  // boots must NOT touch the shared GreenAPI instance, or they overwrite
  // production's webhook with an unreachable URL.
  const webhookUrl = env.BACKEND_URL ? `${env.BACKEND_URL}/api/whatsapp/webhook` : null;
  const isPublicWebhook =
    !!webhookUrl &&
    webhookUrl.startsWith("https://") &&
    !/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(webhookUrl);

  if (isPublicWebhook) {
    setWebhookSettings(webhookUrl!)
      .then(() => logger.info({ webhookUrl }, "GreenAPI webhook registered"))
      .catch((err: unknown) =>
        logger.warn({ err, webhookUrl }, "GreenAPI webhook registration failed — continuing"),
      );
  } else {
    logger.info(
      { webhookUrl, nodeEnv: env.NODE_ENV },
      "Skipping GreenAPI webhook registration — BACKEND_URL is not a public HTTPS URL",
    );
  }

  // Timeless webhook registration + hourly poll cron — skipped in dev (same guard as WhatsApp above)
  if (isPublicWebhook && env.TIMELESS_API_KEY) {
    ensureWebhookRegistered()
      .then(() => logger.info("Timeless webhook registered"))
      .catch((err: unknown) =>
        logger.warn({ err }, "Timeless webhook registration failed — continuing"),
      );
    startTimelessPollCron();
  } else {
    logger.info(
      { nodeEnv: env.NODE_ENV },
      "Skipping Timeless webhook/cron — BACKEND_URL is not public or TIMELESS_API_KEY is not set",
    );
  }

  // All schedulers — public deployments only (guard prevents dev boots from sending
  // live WhatsApp messages, mutating prod data, or overwriting production webhooks)
  if (isPublicWebhook) {
    startCommitmentCrons();

    // Calendar sync: initial run after 30s, then every 3 minutes
    setTimeout(() => {
      syncNewBookings().catch((err: unknown) =>
        logger.error({ err }, "booking-sync: initial run failed"),
      );
    }, 30_000);
    setInterval(() => {
      syncNewBookings().catch((err: unknown) =>
        logger.error({ err }, "booking-sync: scheduled run failed"),
      );
    }, 3 * 60 * 1000);

    // Reminder check: every 10 minutes
    setInterval(() => {
      checkAndSendReminders().catch((err: unknown) =>
        logger.error({ err }, "reminder: scheduled check failed"),
      );
    }, 10 * 60 * 1000);

    // Service meeting eligibility — daily (every 24h)
    setInterval(() => {
      checkServiceMeetingEligibility().catch((err: unknown) =>
        logger.error({ err }, "service-meeting: eligibility check failed"),
      );
    }, 24 * 60 * 60 * 1000);
  } else {
    logger.info("Skipping booking/reminder schedulers — BACKEND_URL not public");
  }
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

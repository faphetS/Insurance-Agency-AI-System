import cookieParser from "cookie-parser";
import cors from "cors";
import cron from "node-cron";
import express, { type Request, type Response } from "express";
import { ensureClientDocumentsBucket } from "./lib/storage.js";
// v4: disabled — calendar/timeless machinery gated off (services kept dormant).
// import { ensureWebhookRegistered } from "./domains/integrations/timeless/timeless.service.js";
// import { startTimelessPollCron } from "./domains/integrations/timeless/timeless.poll.js";
import { startCommitmentCrons } from "./domains/commitments/commitments.service.js";
import { sendMorningDigest } from "./domains/operations/morning-digest.service.js";
import { runStaffEmailNotify } from "./domains/operations/email-mentions.service.js";
import { runUnansweredEmailNotify } from "./domains/operations/unanswered-emails.service.js";
import { sweepUnanswered, sendCallbackReminders } from "./domains/operations/unanswered-wa.service.js";
import { applyRelevanceDropdowns, sweepRelevanceMoves } from "./domains/integrations/google/leads-relevance.service.js";
import { syncNewBookings } from "./domains/calendar/booking-sync.service.js";
// v4: disabled — calendar 24h/1h reminders stay gated off (service kept dormant).
// import { checkAndSendReminders } from "./domains/calendar/reminder.service.js";
import { checkIntakeStalls } from "./domains/ai/intake-stall.service.js";
import helmet from "helmet";
import hpp from "hpp";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../assets");

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
// The webhook route gets 20 MB to accommodate large GreenAPI media payloads.
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

// 8. Rate limiting — webhook routes are exempt (token/HMAC-gated; Meta sends
// ~3 status webhooks per outbound plus retry storms that would trip 429s).
// Mounted at /api, so req.path here excludes the /api prefix.
app.use(
  "/api",
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: "error", code: "RATE_LIMITED", message: "Too many requests" },
    skip: (req) => req.path === "/whatsapp/webhook" || req.path === "/whatsapp/meta-webhook",
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
app.use("/assets", express.static(assetsDir));

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

  const webhookUrl = env.BACKEND_URL ? `${env.BACKEND_URL}/api/whatsapp/webhook` : null;
  const isPublicWebhook =
    !!webhookUrl &&
    webhookUrl.startsWith("https://") &&
    !/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(webhookUrl);

  // v4: disabled — Timeless webhook registration + hourly poll cron (post-meeting flow gated off).
  // The Timeless webhook route stays registered (HMAC-verified, dormant); only these run-loops are off.
  // if (isPublicWebhook && env.TIMELESS_API_KEY) {
  //   ensureWebhookRegistered()
  //     .then(() => logger.info("Timeless webhook registered"))
  //     .catch((err: unknown) =>
  //       logger.warn({ err }, "Timeless webhook registration failed — continuing"),
  //     );
  //   startTimelessPollCron();
  // } else {
  //   logger.info(
  //     { nodeEnv: env.NODE_ENV },
  //     "Skipping Timeless webhook/cron — BACKEND_URL is not public or TIMELESS_API_KEY is not set",
  //   );
  // }

  // All schedulers — public deployments only (guard prevents dev boots from sending
  // live WhatsApp messages, mutating prod data, or overwriting production webhooks)
  if (isPublicWebhook) {
    startCommitmentCrons();

    cron.schedule(
      "0 9 * * *",
      () => {
        sendMorningDigest().catch((err: unknown) =>
          logger.error({ err }, "morning-digest: daily run failed"),
        );
        runStaffEmailNotify().catch((err: unknown) =>
          logger.error({ err }, "email-mentions: daily run failed"),
        );
        runUnansweredEmailNotify().catch((err: unknown) =>
          logger.error({ err }, "unanswered-emails: daily run failed"),
        );
        sendCallbackReminders().catch((err: unknown) =>
          logger.error({ err }, "unanswered-wa: daily callback-reminder run failed"),
        );
        applyRelevanceDropdowns().catch((err: unknown) =>
          logger.error({ err }, "leads-relevance: daily dropdown re-apply failed"),
        );
      },
      { timezone: "Asia/Jerusalem" },
    );

    // Booking-sync (v4.1): confirm new Google Calendar bookings over WhatsApp —
    // first run 30s after boot, then every 3 minutes. Reminders stay OFF below.
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

    // v4: disabled — calendar 24h/1h reminder check (services kept dormant).
    // setInterval(() => {
    //   checkAndSendReminders().catch((err: unknown) =>
    //     logger.error({ err }, "reminder: scheduled check failed"),
    //   );
    // }, 10 * 60 * 1000);

    // Intake stall watcher — every 10 minutes, alert Didi when the consent/ID step stalls 3h+.
    setInterval(() => {
      checkIntakeStalls().catch((err: unknown) =>
        logger.error({ err }, "intake-stall: scheduled check failed"),
      );
    }, 10 * 60 * 1000);

    // Unanswered-WA sweeper — every 2 minutes, auto-reply (with buttons) on Didi's own line
    // after 10 minutes of silence, Sun-Thu 09:00-18:00 Israel time only.
    setInterval(() => {
      sweepUnanswered().catch((err: unknown) =>
        logger.error({ err }, "unanswered-wa: scheduled sweep failed"),
      );
    }, 2 * 60 * 1000);

    // Leads relevance — F-column dropdowns applied at boot (idempotent), rows moved every 5 min.
    setTimeout(() => {
      applyRelevanceDropdowns().catch((err: unknown) =>
        logger.error({ err }, "leads-relevance: boot dropdown apply failed"),
      );
    }, 30 * 1000);

    setInterval(() => {
      sweepRelevanceMoves().catch((err: unknown) =>
        logger.error({ err }, "leads-relevance: scheduled sweep failed"),
      );
    }, 5 * 60 * 1000);
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

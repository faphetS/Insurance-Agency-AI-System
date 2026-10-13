import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  // pino-http logs every request's full headers through this logger — keep credentials out.
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    censor: "[redacted]",
  },
  ...(env.NODE_ENV === "development" && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  }),
});

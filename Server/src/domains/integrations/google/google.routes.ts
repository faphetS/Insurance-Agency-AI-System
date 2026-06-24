import { Router, type Request, type Response } from "express";
import { getAuthUrl, handleCallback, getStatus } from "./google.auth.js";
import { logger } from "../../../config/logger.js";

const router = Router();

router.get("/authorize", (_req: Request, res: Response) => {
  const url = getAuthUrl();
  res.redirect(url);
});

router.get("/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    await handleCallback(code);
    res.send("Google connected. You can close this tab.");
  } catch (err) {
    logger.error({ err }, "google-ws: OAuth callback failed");
    const message = err instanceof Error ? err.message : "Authorization failed";
    res.status(400).send(message);
  }
});

router.get("/status", async (_req: Request, res: Response) => {
  const status = await getStatus();
  res.json(status);
});

export default router;

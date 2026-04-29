import { Router, type Request, type Response } from "express";
import { getAuthUrl, handleCallback } from "./calendar.auth.js";
import { logger } from "../../config/logger.js";

const router = Router();

router.get("/oauth/authorize", (_req: Request, res: Response) => {
  const url = getAuthUrl();
  res.redirect(url);
});

router.get("/oauth/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    await handleCallback(code);
    res.send(`
      <html><body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
        <div style="text-align: center;">
          <h1 style="color: #2e7d32;">Authorization Successful!</h1>
          <p>Google Calendar is now connected. You can close this tab.</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    logger.error({ err }, "calendar: OAuth callback failed");
    res.status(500).send("Authorization failed. Check server logs.");
  }
});

export default router;

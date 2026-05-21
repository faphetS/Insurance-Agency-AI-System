# Placeholder Features — Pending API Connections

These Component B (Operational Assistant) features are structurally built but return stub/placeholder data until their external APIs are connected.

## 1. Email Scanning
**Status:** Not Connected
**Needs:** Gmail API key (or IMAP credentials)
**Accounts to monitor:**
- merav@shaked-ins.com
- hodaya@shaked-ins.com
- giti@shaked-ins.com
- rivka@shaked-ins.com
- tzivia@shaked-ins.com
- ruth@shaked-ins.com
- yafa@shaked-ins.com
- didi@shaked-ins.com

**What to do:** Replace `StubEmailProvider` in `Server/src/domains/operations/operations.email.ts` with a real Gmail/IMAP provider. The service, controller, routes, and frontend are already wired.

## 2. WhatsApp Monitoring (Staff Numbers)
**Status:** Not Connected
**Needs:** Each number requires its own GreenAPI instance sending webhooks
**Numbers:**
- 055-976-2838 — Health, Pension & Finance Department
- 053-322-8285 — Property, Auto, Home & Business Department
- 054-772-5826 — Didi

**Note:** These are staff phones, separate from the bot's GreenAPI instance.
**What to do:** Replace `StubWhatsappMonitor` in `Server/src/domains/operations/operations.whatsapp-monitor.ts`. Set up 3 GreenAPI instances, configure webhooks, store instance credentials in env vars.

## 3. Service Meetings (24-month reminder)
**Status:** Partially working — queries `clients.last_service_date` but column is null for all clients
**Needs:** BAFI CRM integration to populate `last_service_date`
**CRM:** BAFI (Israeli insurance CRM) — having integration difficulties
**What to do:** Wire up `StubBafiProvider` in `Server/src/domains/operations/operations.bafi.ts` with real BAFI API calls. Once `last_service_date` is populated, the service meetings feature works automatically.

---
*Created 2026-05-11*

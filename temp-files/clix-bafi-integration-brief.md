# CLIX × BAFI Integration — Brief for Project Manager

## Background

On May 13, 2026, Didi contacted BAFI about getting API access. **Keren Biton** (אחראית חידושים, BAFI) replied with general information about BAFI's API capabilities and attached an integration guide booklet (general documentation about their integration model, OAuth2 process, security requirements, etc.).

**We have not received API access, credentials, or specific endpoint documentation yet.** Before BAFI can proceed, they need us to send a **Use Case document** so they can evaluate feasibility and fit. This document is that response.

BAFI asked the Use Case document to cover:

1. Which data we need (Read / Write)
2. Which entities in BAFI are relevant
3. A proposed workflow
4. Security considerations

### BAFI's Technical Requirements
- API calls must come from an **Israeli IP** that isn't flagged as malicious
- Our system must have **authentication** — can't be open to public without login
- Authentication method: **OAuth2**
- They also recommend consulting with the **Privacy Protection Authority** since we're connecting an external system to BAFI's data

### Our Status Against These Requirements

| Requirement | Status | Details |
|-------------|--------|---------|
| **Israeli IP** | **NOT MET** | Our server is deployed on a VPS at `187.127.224.73` (not Israeli). We need to either move the server to an Israeli VPS provider (e.g. Kamatera ~$4-10/mo), or ask BAFI to whitelist our specific IP since we're an Israeli company. Asking BAFI first is the easiest path. |
| **Authentication** | **MET** | Our system has JWT authentication, login/register, role-based access control. It's not open to the public — every request requires a valid token. |
| **OAuth2** | **READY** | We already have OAuth2 implemented for Google Calendar integration, so the pattern exists in our codebase. We just need BAFI to give us their Client ID, Client Secret, and Token endpoint — then we wire it up the same way. Can't build it until they provide credentials. |
| **Privacy Authority** | **ACTION NEEDED** | This is a legal/regulatory step for Didi, not a code issue. BAFI recommends consulting because we're connecting an external system to their client data. |

### BAFI's Existing API Capabilities (from Keren's email)
- Pulling client data (ID, name, etc.)
- Uploading files to client records
- Filing WhatsApp chat conversations to client records
- Receiving car insurance quotes from 40+ tracks
- Pushing leads into BAFI's lead management area
- Receiving 9100 files from the pension clearinghouse

### What We Need to Send Back
The Use Case document below. It explains what CLIX does, how it uses BAFI, and exactly which API endpoints we need.

---

## What is CLIX?

Two components:

- **Component A (WhatsApp Client Agent)** — AI chatbot on WhatsApp that handles new leads: collects their info and documents, books meetings with staff.
- **Component B (Operational Assistant)** — Background automation that runs after meetings: checks if forms were sent, policy was issued, first payment was made. Alerts staff when something is stuck.

---

## All Systems CLIX Connects To

| System | What It Does | Role |
|--------|-------------|------|
| **BAFI** | Client records, policies, forms, deposits, tasks, staff | Source of truth — everything reads from or writes to BAFI |
| **GreenAPI** | WhatsApp messaging (1 bot + 3 staff numbers) | Bot talks to leads; we monitor 3 staff WhatsApp numbers for client messages |
| **Google Calendar** | Meeting scheduling | Bot checks staff availability, books meetings |
| **Gmail API** | Email monitoring (8 staff inboxes) | Insurance companies reply by email — we scan for "forms received" / "policy issued" confirmations |
| **AI (Claude/OpenAI)** | Conversation + summaries | Powers the chatbot, generates meeting summaries |

---

## How BAFI Is Used — Step by Step

### Component A: WhatsApp Bot

> Example: Sarah messages us on WhatsApp wanting life insurance.

| Step | What Happens | BAFI API |
|------|-------------|----------|
| 1 | Sarah messages on WhatsApp | *(GreenAPI)* |
| 2 | Check if she's already a client | **GET** — search by phone |
| 3 | She's new — bot collects name, ID, needs | *(our database)* |
| 4 | Sarah sends ID photo | **POST** — create client, **POST** — upload document |
| 5 | Check power of attorney status | **GET** — read client details (POA field) |
| 6 | Offer meeting times | *(Google Calendar)* |
| 7 | Assign staff handler | **GET** — read users/staff list |
| 8 | After meeting, log summary | **POST** — add note to client *(nice-to-have)* |

**Staff assignment for new leads:** Not automated yet — needs a business decision from Didi on how to route (manual assignment, round-robin, by insurance type, or by workload).

### Component B: After the Meeting

> Ruth had a meeting with Sarah. The system now monitors automatically.

| When | Check | BAFI API | If Not Done |
|------|-------|----------|-------------|
| +1 week | Forms submitted? | **GET** — client's forms | Task for Ruth: "Forms not sent" |
| +2 weeks | Insurance company confirmed receipt? | **GET** — policy status | Escalate to Ruth |
| +1 month | Policy active? | **GET** — policy status = "פעיל"? | Follow-up task |
| +2 months | First deposit made? | **GET** — life/elementary collection | Escalate |
| +3 months | Everything settled? | **GET** — policies + collection | Mark complete or escalate |

Each check is just one GET request reading one column — if the value changed, mark done. If not, create a task or escalate.

### Other Background Jobs

| Job | BAFI API |
|-----|----------|
| **Service meeting scan** — daily, finds clients due for 24-month regulatory service meeting | **GET** — client records / task history |
| **Task management** — create and update tasks so staff see them in BAFI | **GET/POST/PUT** — tasks |
| **Email scanning** — scan 8 Gmail inboxes for insurance company replies | *(Gmail, not BAFI)* — results update task chain |
| **WhatsApp monitoring** — monitor 3 staff WhatsApp numbers | *(GreenAPI, not BAFI)* — messages matched to clients |

---

## BAFI API — What We Need

### 1. Clients (לקוחות) — **Essential** — GET / POST / PUT
- **Search** by phone, ID number (ת.ז.), or name
- **Get details**: name, ID, DOB, phone, email, handler (מטפל בלקוח), agency, client type, employer, POA status (נחתם ייפוי כוח)
- **Create** new client (name, phone, ID, email)
- **Update** client fields (email, address, employer)

### 2. Policies & Plans (פוליסות ותוכניות) — **Essential** — GET
- List all policies for a client: policy number, type, status (פעיל/ממתין/מבוטל), insurance company, dates, plan name, fund balance
- Check status of a specific policy

### 3. Tasks (משימות) — **Essential** — GET / POST / PUT
- List tasks filtered by assigned user, client, status, date range
- Create task with subject, description, deadline, assigned staff, linked client
- Update task status (mark complete, change deadline)

### 4. Collection / Deposits (גביה) — **Essential** — GET
- **Life collection**: check if premium payments exist (month, amount, payment date)
- **Elementary collection**: check if property insurance payments exist (debit, credit, balance)

### 5. Users / Staff (משתמשים) — **Essential** — GET
- List all users with names, roles, contact info

### 6. Forms (טפסים) — **Essential** — GET
- List forms for a client (type, date, domain, company)
- Check if forms were submitted after a given date

### 7. Documents (מסמכים) — **Essential** — GET / POST
- List documents on client file (type, upload date)
- Upload document (ID photo, signed POA) to client file

### 8. Service Meeting Date — **Essential** — GET
- Determine when a client's last service meeting occurred
- *Note: no dedicated field found in BAFI UI — we need guidance on how to query this (task history? custom field?)*

### 9. Notes (הערות) — **Nice-to-have** — GET / POST
- Add note to client record (meeting summaries)
- Read existing notes

### Webhooks (if supported)
- Policy status change
- Form submission
- Task completion

---

## Summary Table

| Priority | Method | What |
|----------|--------|------|
| **Essential** | GET | Clients, Policies, Tasks, Collection, Users, Forms, Documents, Service Date |
| **Essential** | POST | Clients (create), Tasks (create), Documents (upload) |
| **Essential** | PUT | Clients (update), Tasks (update status) |
| Nice-to-have | POST | Notes (add) |
| Nice-to-have | GET | Notes (read) |
| Bonus | Webhook | Policy change, Form submission, Task completion |

---

## Security (answering BAFI's requirements)

- **Server:** Node.js / Express / TypeScript
- **Authentication:** JWT-based, login required — system is not open to the public
- **OAuth2:** Already implemented for Google Calendar; ready to add BAFI as another provider once we receive their credentials (Client ID, Secret, Token endpoint)
- **API calls:** Server-to-server only (no client-side/browser calls to BAFI)
- **Rate limiting:** Implemented (100 req/15min), will respect BAFI's limits too
- **Audit logging:** All mutations logged with IP, user, timestamp
- **Input validation:** Zod schemas on all endpoints
- **Security headers:** Helmet (CSP, HSTS), CORS configured
- **Data:** All data stays internal to the agency — no external sharing

### Open Item: Israeli IP
Our server is currently on a non-Israeli VPS. Options:
1. **Ask BAFI to whitelist our IP** — easiest, worth trying first
2. **Move to Israeli VPS** (Kamatera, ~$4-10/mo) — CI/CD just needs a new SSH target
3. **Israeli proxy** — route only BAFI calls through an Israeli server — more complex

### Open Item: Privacy Authority
Didi should be aware that BAFI recommends consulting with רשות הגנת הפרטיות before connecting.

---

## Contacts

**Our side:**
Didi Friedlander — didi@ddins.net | 054-7725826 | 073-7770555
שקד סוכנות לביטוח (2016) בע"מ, שדרות הרצל 50 ירושלים

**BAFI side:**
Keren Biton (קרן ביטון) — kerenbi@b-com.co.il | 053-9450230 | 074-7144333

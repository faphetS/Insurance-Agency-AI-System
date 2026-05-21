# BAFI API Access Request — Use Cases

## Who We Are
Shaked Insurance Agency (שקד סוכנות לביטוח 2016 בע"מ), account managed by Didi Friedlander.
We are building an internal automation system (CLIX) that integrates with BAFI to automate operational workflows. The system has two components:
- **Component A (WhatsApp Client Agent)** — customer-facing AI that handles intake, document collection, and meeting scheduling via WhatsApp
- **Component B (Operational Assistant)** — internal automation for task tracking, client follow-ups, reminders, and service meeting scheduling

---

## Endpoint Map — Where Each API Is Used

### Component A: WhatsApp Client Agent

| Step | What Happens | BAFI API | Priority |
|------|-------------|----------|----------|
| New lead messages on WhatsApp | Check if client exists by phone number | `GET /clients?phone={phone}` | **Essential** |
| Lead doesn't exist | Create new client record | `POST /clients` | **Essential** |
| Bot collects ID number | Update client with ת.ז. | `PUT /clients/{id}` | **Essential** |
| Lead sends ID photo / POA | Upload document to client file | `POST /clients/{id}/documents` | **Essential** |
| Bot checks POA status | Read power of attorney field | `GET /clients/{id}` (נחתם ייפוי כוח field) | **Essential** |
| Meeting booked, staff assigned | Read staff list to match handler | `GET /users` | **Essential** |
| Meeting summary approved | Log summary as note on client | `POST /clients/{id}/notes` | Nice-to-have |

### Component B: Operational Assistant — Scheduled Jobs

| Scheduled Job | Runs | What It Checks | BAFI API | Priority |
|--------------|------|---------------|----------|----------|
| **Forms check** | +1 week after meeting | Were forms submitted for this client? | `GET /clients/{id}/forms` | **Essential** |
| **Receipt check** | +2 weeks after meeting | Did insurance company acknowledge receipt? | `GET /clients/{id}/policies` (status field) | **Essential** |
| **Policy check** | +1 month after meeting | Is the policy now active? | `GET /clients/{id}/policies` (סטטוס פוליסה = פעיל?) | **Essential** |
| **Deposit check** | +2 months after meeting | Was first payment made? | `GET /clients/{id}/collection` (life or elementary) | **Essential** |
| **Final verify** | +3 months after meeting | Everything settled? | `GET /clients/{id}/policies` + `GET /clients/{id}/collection` | **Essential** |
| **Service meeting eligibility** | Daily scan | When was last service meeting? (24-month regulation) | `GET /clients/{id}` or task/meeting history | **Essential** |
| **Task tracking** | Ongoing | Read/create/update tasks for staff | `GET /tasks`, `POST /tasks`, `PUT /tasks/{id}` | **Essential** |
| **SLA breach check** | Periodic | Are any tasks overdue? | `GET /tasks?status=open&deadline_before={date}` | Nice-to-have |

---

## Detailed Endpoint Descriptions

### 1. Clients (לקוחות) — **Essential**

| Method | Use Case | Description |
|--------|----------|-------------|
| `GET` | **Search clients** | Search by phone number, ID number (ת.ז.), or name |
| `GET` | **Get client details** | Full record: name, ID, DOB, phone, email, handler (מטפל בלקוח), agency, client type, employer, POA status (נחתם ייפוי כוח) |
| `POST` | **Create client** | Create new record (name, phone, ID, email) |
| `PUT` | **Update client** | Update fields (email, address, employer) |

**Used by:** Component A (lookup + create on new lead), Component B (read handler for task assignment)

---

### 2. Policies & Plans (פוליסות ותוכניות) — **Essential**

| Method | Use Case | Description |
|--------|----------|-------------|
| `GET` | **Get client policies** | All policies: policy number, type, status (פעיל/ממתין/מבוטל), insurance company, start/end date, plan name, fund balance |
| `GET` | **Get policy status** | Check if a specific policy is active, pending, or cancelled |

**Used by:** Component B scheduled jobs — receipt check (+2w), policy check (+1m), final verify (+3m)

---

### 3. Tasks (משימות) — **Essential**

| Method | Use Case | Description |
|--------|----------|-------------|
| `GET` | **List tasks** | Filter by: assigned user, client, status, date range |
| `POST` | **Create task** | New task with subject, description, deadline, assigned staff, linked client |
| `PUT` | **Update task status** | Mark complete or update deadline |

**Used by:** Component B — creates the 5-step task chain after each meeting, reads task status for dashboard

---

### 4. Collection / Deposits (גביה) — **Essential**

| Method | Use Case | Description |
|--------|----------|-------------|
| `GET` | **Life collection** | Check if premium payments exist for a client's policy (חודש פרמיה, סכום, תאריך פרעון) |
| `GET` | **Elementary collection** | Check if property insurance payments exist (חובה, זכות, יתרה) |

**Used by:** Component B — deposit check (+2m) and final verify (+3m)

---

### 5. Users / Staff (משתמשים) — **Essential**

| Method | Use Case | Description |
|--------|----------|-------------|
| `GET` | **List users** | All users with names, roles, contact info |

**Used by:** Component A (assign handler after meeting), Component B (route tasks to correct staff)

---

### 6. Forms (טפסים) — **Essential**

| Method | Use Case | Description |
|--------|----------|-------------|
| `GET` | **Get client forms** | List forms for a client: form type (תביעות/הצעות/הצטרפות), date, domain (בריאות/חיים), company, status |

**Used by:** Component B — forms check (+1w): did the required forms appear in the system?

---

### 7. Documents (מסמכים) — **Essential**

| Method | Use Case | Description |
|--------|----------|-------------|
| `GET` | **List client documents** | Documents on file (type, upload date) |
| `POST` | **Upload document** | Attach document (ID photo, signed POA) to client file |

**Used by:** Component A — bot collects documents via WhatsApp and pushes them into BAFI

---

### 8. Notes (הערות) — Nice-to-have

| Method | Use Case | Description |
|--------|----------|-------------|
| `POST` | **Add note** | Log meeting summary or follow-up action on client record |

**Used by:** Component A — after meeting summary is approved, log it to BAFI for audit trail

---

### 9. Service Meeting Tracking — **Essential**

| Method | Use Case | Description |
|--------|----------|-------------|
| `GET` | **Get last service date** | Determine when last service meeting occurred for a client |

**Used by:** Component B — daily scan identifies clients approaching 24-month service deadline

**Note:** We explored the BAFI client card and did not find a dedicated "last service date" field. If there is such a field (perhaps in a custom field or hidden section), please let us know how to access it via API. If not, we'd appreciate guidance on the best approach — querying tasks/meetings by type, or using a custom field we maintain ourselves.

---

## Summary

| Priority | Access | Endpoints |
|----------|--------|-----------|
| **Essential GET** | Read | Clients, Policies, Tasks, Collection (Life + Elementary), Users, Forms, Documents, Service Date |
| **Essential POST** | Write | Clients (create), Tasks (create), Documents (upload) |
| **Essential PUT** | Update | Clients (update fields), Tasks (update status) |
| **Nice-to-have POST** | Write | Notes (add meeting summary) |

## Nice-to-Have: Webhooks

If BAFI supports webhooks or event notifications:
- **Policy status change** — notify when a policy is issued or cancelled
- **New form submission** — notify when a client submits a form
- **Task completion** — notify when staff completes a task

These would replace periodic polling with real-time updates.

---

## Technical Details

- Our system runs on Node.js/Express with TypeScript
- We can authenticate via API keys, OAuth tokens, or JWT — whichever BAFI's API supports
- We will respect rate limits and implement caching to minimize API calls
- All data access is for internal operational use only within the agency

## Contact

Didi Friedlander
שקד סוכנות לביטוח (2016) בע"מ
didi@ddins.net | 073-7770555

# BAFI CRM — Complete Reference (from live exploration 2026-05-15)

## Login & Access
- URL: https://ext.bafi.co.il
- Account: Didi Friedlander (didi@ddins.net)
- Company: שקד סוכנות לביטוח (2016) בע"מ
- Tax ID (ת.פ): 515385425
- Company reg (ע.מ): 023620347
- API portal exists at: api.bafi (seen in earlier exploration)
- Auth method: RS256 JWT (seen in network captures, user ID format: `bafi.ext:1009667`)
- API base URL (from network captures): `https://ext.bafi.co.il/api/*`
- Known API endpoints (from network): `/api/user/main-data`, `/api/homepage/load-sidebar-data`, `/api/homepage/load-data`

## Top Navigation Bar
1. **דף הבית** (Home) — Dashboard with news, updates, videos
2. **ניהול משרד** (Office Management) — Main CRM module (see below)
3. **טפסים** (Forms) — Form builder/management
4. **פריזבי חדשים** (New Frisbees) — Insurance comparison tool
5. **Mobile2CRM** — Mobile app integration
6. **99Digital (WhatsApp)** — WhatsApp integration module
7. **Jaro AI (BETA)** — AI call transcription & analysis
8. **בי-סמארט (מרכזייה)** (B-Smart PBX) — Phone system integration
9. **מסלקה Online** (Online Clearing House) — Insurance clearing house
10. **הסימולטור החדש** (New Simulator) — Insurance product simulator
11. **תמיכה טכנית** (Technical Support)
12. **הגדרות** (Settings) — User & company settings
13. **ניהול מערכת** (System Management) — Users, permissions, modules

## Office Management (ניהול משרד) — Sidebar Sections
1. **שולחן עבודה** (Desktop/Dashboard)
2. **B-mail** — Internal email system
3. **לקוחות** (Clients) — Full client management
4. **תביעות** (Claims) — Insurance claims tracking
5. **משימות** (Tasks) — Task management system
6. **יומן** (Calendar) — Schedule/diary
7. **פקסים** (Faxes)
8. **מעסיקים** (Employers) — Employer records
9. **סוכנים** (Agents) — Agent/broker records
10. **אנשי קשר** (Contacts) — Contact management
11. **SMS** — SMS sending
12. **מסלקה** (Clearing House)
13. **תמונת מצב** (Status Overview) — Portfolio overview

## Client List (לקוחות) — Table Columns
| Column (Hebrew) | English | Notes |
|---|---|---|
| מס' תיק | File/Case number | BAFI internal client ID |
| שם | Name | Full name |
| ת. לידה | Date of birth | |
| ת.ז./ח.פ. | ID number / Company reg | Primary identifier |
| טלפונים | Phone numbers | Can have multiple |
| פקס | Fax | |
| דוא"ל | Email | |
| כתובת | Address | Full address with city |
| סוכן | Agent | Assigned agent name |
| שם הסוכנות/קבוצה | Agency/Group name | |
| סוכן מיסוי | Tax agent | |
| סטטוס מיסוי | Tax status | |

### Filters Available
- סוג לקוח (Client type)
- קבוצה (Group)
- שם הסוכנות/קבוצה (Agency name)
- סוכן (Agent)
- מטפל בלקוח (Client handler)

## Client Card (כרטיס לקוח) — Detail Fields

### Main Fields (right panel)
| Field (Hebrew) | English | Type |
|---|---|---|
| ת.ז | ID number | string |
| תאריך לידה | Date of birth | date (shows age) |
| מגדר | Gender | enum (male/female) |
| ת.הנפקת תעודה | ID issue date | date |
| מטפל בלקוח | Client handler | FK to user |
| שם הסוכנות/קבוצה | Agency/Group | string |
| שם הסוכן/ת | Agent name | string |
| סוג לקוח | Client type | enum (פרטי=Individual, etc.) |

### Additional Fields (פרטים נוספים)
| Field | English |
|---|---|
| מס' תיק | File number |
| מזהה ייחודי | Unique identifier |
| מקום עבודה | Workplace |
| מספר דרכון | Passport number |
| גורם מפנה | Referring party |
| קופת חולים | Health fund |
| נחתם ייפוי כוח | Power of attorney signed (yes/no) |
| מעסיק | Employer (linked) |

### Contact (יצירת קשר)
| Field | English |
|---|---|
| נייד | Mobile phone |
| דוא"ל | Email |
| כתובת | Address |

### Other Sections on Client Card
- **קשרים** (Relations) — linked people/entities
- **הערות** (Notes) — free-text notes
- **שדות מותאמים אישית** (Custom fields) — configurable extra fields

## Client Card — Tabs
| Tab (Hebrew) | English | Purpose |
|---|---|---|
| כרטיס לקוח | Client Card | Main personal/contact details |
| טיפול שוטף | Ongoing Treatment | Current actions/tasks for client |
| פוליסות ותוכניות | Policies & Plans | All insurance policies |
| הצעות | Proposals | Insurance quotes/proposals |
| תביעות | Claims | Insurance claims |
| מסמכים | Documents | Uploaded documents |
| גביה אלמנטרי | Elementary Collection | Property insurance payments |
| גבייה חיים | Life Collection | Life insurance payments |
| קשרי לקוח | Client Relations | Communication history |
| תמונת מצב | Status Overview | Summary dashboard |
| טפסים | Forms | Client-specific forms |

## Policy Categories (from Profile Settings dialog)
1. **חיים** (Life insurance)
2. **שוק הון** (Capital market / investments)
3. **פנסיה** (Pension)
4. **סיעודי** (Long-term care)
5. **משכנתא** (Mortgage)
6. **אלמנטרי** (Elementary / Property insurance)
7. **ביטוח אישי** (Personal insurance)

## Policies & Plans (פוליסות ותוכניות) — Table Columns
Verified on client Barko Shay (9 active policies).
| Column (Hebrew) | English | Notes |
|---|---|---|
| מס' פוליסה | Policy number | e.g., 7-926-663305-0 |
| סוג פוליסה | Policy type | שוק הון (Capital Market), חיים (Life) |
| חברת ביטוח | Insurance company | e.g., אקסלנס גמל, מיטב דש |
| ת. התחלה | Start date | |
| ת. סיום | End date | |
| סטטוס פוליסה | Policy status | פעיל (Active), etc. |
| מס' רכב / מוצר | Vehicle/Product number | |
| שם הרכב | Vehicle name | Product sub-type |
| פתיחה | Opening amount | ₪ |
| שם תוכנית | Plan name | e.g., מיטב פנסיה |
| מעמד קופה | Fund status | שכיר (Salaried), etc. |
| יתרה הקופה | Fund balance | ₪ |
| שם קופה / שם מסלול | Fund/Track name | |
| נכון ליום | As of date | e.g., 31/03/2026 |
| משתמש | User | Staff who manages |

### Product Types Seen
- קרן השתלמות (Continuing Education Fund)
- קרן פנסיה (Pension Fund)
- קופת גמל (Provident Fund)
- קופת גמל להשקעה (Investment Provident Fund)
- ביטוח משכנתא (Mortgage Insurance)
- פוליסות ביטוח חיים משולב חיסכון (Combined Life + Savings)
- פוליסת חיסכון טהור (Pure Savings)
- פוליסת סיכון טהור (Pure Risk)
- פוליסת סיכון טהור קולקטיב (Collective Pure Risk)
- ביטוח רכוש (Property Insurance)
- ביטוח בריאות (Health Insurance)
- ביטוח סיעודי ופרט (Long-term Care & Individual)

## Life Collection (גבייה חיים) — Columns
Verified on client Barko Shay (20 records, multiple employers).

### Policy-level columns
| Column (Hebrew) | English |
|---|---|
| מספר פוליסה | Policy number |
| חברה | Insurance company |
| מעסיק | Employer |
| סוג דוח | Report type |
| סוג מוצר/תשלום | Product/Payment type (e.g., קרן פנסיה, קרן השתלמות) |
| חודש פרמיה | Premium month |

### Employer premium (פרמיה למעסיק)
| Column | English |
|---|---|
| שכר | Salary |
| פיצויים | Severance pay |
| תגמולים | Benefits |
| א.כ.ע | Disability insurance |
| שונות | Miscellaneous |
| סה"כ מעסיק | Total employer |

### Employee premium (פרמיה לעובד)
| Column | English |
|---|---|
| תג' 45 | Benefit 45 |
| תג' 47 | Benefit 47 |
| א.כ.ע | Disability |
| שונות | Miscellaneous |

### Summary columns
| Column | English |
|---|---|
| סה"כ עובד | Total employee |
| סה"כ % הפרשות | Total % deposits |
| סה"כ לתשלום | Total to pay |

### Last Deposit Details (פירוט הפקדה אחרונה)
| Column | English |
|---|---|
| חברה | Company |
| חודש פרמיה | Premium month |
| סוג תשלום | Payment type |
| תאריך פרעון | Payment date |
| בנק | Bank |
| סניף | Branch |
| חשבון | Account |
| מס' שק | Check number |
| נתקבל בתאריך | Received date |
| סכום | Amount |
| הערות | Notes |

## Elementary Collection (גביה אלמנטרי) — Columns
Verified on client Barko Shay (no data rows, but columns visible).
| Column (Hebrew) | English |
|---|---|
| תאריך | Date |
| מס' | Number |
| סוכן | Agent |
| מס' סוכן | Agent number |
| חברה | Company |
| מס' פוליסה | Policy number |
| חובה | Debit |
| זכות | Credit |
| יתרה | Balance |
| סוג תשלום | Payment type |
| הערות | Notes |
| משתמש | User |

Filter: date range (מ- / עד), New document button, Print list button.

## Forms (טפסים) — Detail
Verified on client Barko Shay (13+ forms).

### Sub-tabs
- רשימת טפסים (Forms list) — main list
- ערכות טפסים (Form sets)
- טפסים בטיפול (Forms in process/pending)

### Filter fields
- ענף (Branch/Sector)
- תחום (Domain/Area)
- סוג הטופס (Form type)
- מועדפים (Favorites)

### Table Columns
| Column (Hebrew) | English | Example |
|---|---|---|
| מק"ט | Catalog number | 26027830114010916 |
| תאריך טופס | Form date | 09/2017 |
| סוג הטופס | Form type | תביעות (Claims), הצעות (Proposals), הצטרפות (Enrollment), אחר (Other) |
| תחום | Domain | בריאות (Health), חיים (Life), נסיעות לחו"ל (Travel), רכב (Vehicle), אחר (Other), פיננסים (Finance) |
| ענף | Branch | סיכונים (Risks), רכוש (Property), חיסכון ארוך טווח (Long-term Savings) |
| חברה/יצרן | Company/Manufacturer | מגדל, מנורה, פניקס, פספורטכארד, אקסלנס |
| עמ' | Pages | Page count |
| שם הטופס | Form name | Full descriptive name |

### Buttons
- פתח טופס (Open form) — opens/downloads form
- הדפס טופס (Print form)
- הגש בקשה להוספת טופס (Request to add form)

## Tasks (משימות) — Table Columns
| Column (Hebrew) | English |
|---|---|
| נוצר | Created date |
| נושא | Subject/Topic |
| יעד סיום | Deadline |
| שלבים בתהליך | Process stages |
| התקדמות בתהליך | Progress |
| תאריך תכולות | Content date |
| סוכן | Agent |
| חברה | Company |
| לטיפול ע"י | Assigned to |
| תיאור | Description |
| מעסיק | Employer |
| ת.ז לקוח | Client ID |
| נוצר ע"י | Created by |
| שייך ל | Belongs to |

### Task Filters
- סטטוס (Status)
- לטיפול ע"י (Assigned to)
- חברה (Company)
- נושא (Subject)
- סוכן (Agent)
- מתאריך / עד תאריך (Date range)
- ללא סינון (No filter)

## Staff / Users (from System Management)
| # | Name (Hebrew) | Name (English) | Email (from stub code) |
|---|---|---|---|
| 1 | דידי פרידלנדר | Didi Friedlander | didi@shaked-ins.com |
| 2 | יפה נוימן | Yafa Neuman | yafa@shaked-ins.com |
| 3 | צביה הורביץ | Tzivia Horowitz | tzivia@shaked-ins.com |
| 4 | רות קורנפיין | Ruth Kornfein | ruth@shaked-ins.com |
| 5 | גיטי גרינבוים | Giti Greenbaum | giti@shaked-ins.com |
| 6 | מירב ששון | Merav Sasson | merav@shaked-ins.com |
| 7 | הודיה זרביב | Hodaya Zarbiv | hodaya@shaked-ins.com |
| 8 | רבקה קציר | Rivka Katzir | rivka@shaked-ins.com |

## Agents List (סוכנים)
Table columns exist but list showed empty with default filter. Columns:
- שם הסוכנות/קבוצה, שם, שם סוכנות, ת.ז/ע.מ., טלפון, טלפון נייד, פקס, דוא"ל, תאריך לידה, כתובת

## Settings Page
### User Settings (פרטי משתמש)
- First name, Last name, Email, Phone, Fax, Extension number
- Digital signature update option

### Company Settings (פרטי חברה)
- Company name, Tax ID, Company reg, Logo
- Area, City, Street, Zip
- Phone 1, Phone 2, Fax, Email, Website

### Settings Sub-sections (sidebar icons)
- רשימות (Lists) — custom dropdown lists
- תבניות מכתבים (Letter templates)
- תבניות SMS (SMS templates)
- תבניות בריאות (Health templates)
- הצהרת ריסק (Risk declaration)

## What's NOT Visible / Missing
1. **last_service_date** — No dedicated field on client card. May need to derive from task history or add a custom field. Asked BAFI for guidance in API request email.
2. **API configuration** — No API settings page visible in Settings or System Management UI
3. **Webhook configuration** — Not visible in the UI
4. ~~**Deposit/payment details**~~ — **RESOLVED**: Life Collection columns fully documented (premium breakdown, last deposit details)
5. ~~**Form submission status**~~ — **RESOLVED**: Forms tab fully documented (form list, types, dates, companies, sub-tabs for pending forms)
6. ~~**Policy detail fields**~~ — **RESOLVED**: Policies tab fully documented (policy number, type, status, company, dates, fund balance, plan name)

### Navigation Note
BAFI uses ExtJS with nested iframes. Tab navigation via click doesn't work through browser automation — must use ExtJS API: `Ext.getCmp('ext-comp-1544').setActiveTab(Ext.getCmp('TAB_ID'))` inside the `if_crm_clients` iframe's contentWindow.

## Known API Information (from network captures)
- Base: `https://ext.bafi.co.il/api/*`
- Auth: Bearer JWT (RS256)
- Known endpoints:
  - `POST /api/user/main-data` — body: `{"select":"users,main_user"}`
  - `POST /api/homepage/load-sidebar-data` — body: `{}`
  - `POST /api/homepage/load-data` — body: `{}`
- API portal: api.bafi (separate site)
- User identifier format: `bafi.ext:1009667`

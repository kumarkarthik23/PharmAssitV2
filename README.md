---
title: PharmAssist V2
emoji: 💊
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
license: mit
tags:
  - fastapi
  - healthcare
  - gemini
  - ai
  - pharmacy
  - sqlite
  - python
short_description: AI pharmacy - scan prescriptions, inventory & analytics
---

<div align="center">

# PharmAssist V2

**AI-powered pharmacy management**

[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash-4285F4?logo=google&logoColor=white)](https://deepmind.google/technologies/gemini/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

*Scan handwritten prescriptions · Manage batch-tracked inventory · Monitor pharmacy analytics*
**Demo Link: https://huggingface.co/spaces/Karthik2399/PharmAssistV2**
**Demo PIN: `1234`**

</div>

---

## Overview

PharmAssist V2 is a full-stack pharmacy management system built as a portfolio project. A pharmacist can photograph a handwritten prescription, have the drug list extracted automatically by Google Gemini Vision, verify stock availability against live inventory, and dispense in one click — while the dashboard tracks revenue, fill rate, stock health, and expiry risk in real time.

```
Upload prescription image
        ↓
Gemini 2.5 Flash extracts drug names · frequencies · durations
        ↓
rapidfuzz matches each drug against inventory (exact + fuzzy)
        ↓
Review availability · adjust quantities · Confirm Sale
        ↓
Stock deducted FIFO · Receipt generated · History logged
```

---

## Features

### Prescription Processing
- **AI extraction** — Gemini 2.5 Flash reads handwritten prescriptions (JPEG, PNG, WebP) and returns structured drug name, frequency, duration, and calculated quantity needed
- **Edit medicines** — correct any misread names or doses before checking stock
- **Manual entry fallback** — keyboard entry when no image is available or Gemini quota is exhausted
- **Fuzzy matching** — `rapidfuzz` token sort ratio matches extracted names to inventory; fuzzy matches are clearly labelled in the UI
- **Add to Inventory & Return** — if a drug is not found, one click navigates to Inventory with the name pre-filled, then returns and re-checks availability automatically
- **Partial sale detection** — if only some drugs can be dispensed, the receipt labels the partial outcome and lists unfulfilled items
- **Duplicate detection** — file hash check warns if the same prescription image has been processed recently
- **Resume flow** — pending or abandoned prescriptions can be resumed from History without re-uploading the image
- **Print receipt** — print-optimised receipt with line totals and grand total

### Inventory Management
- **Batch tracking** — each drug holds multiple stock batches with individual expiry dates, quantities, supplier, and lot notes
- **FIFO dispensing** — stock is always consumed from the batch with the earliest expiry date first; enforced with `BEGIN IMMEDIATE` locking to prevent race conditions
- **Expiry timeline** — batches grouped into Already Expired / ≤30 days / ≤60 days / ≤90 days at the top of the Inventory page
- **Write-off** — expired batches zeroed in one action; every write-off logged to an audit trail
- **Bulk restock** — CSV upload to add many batches at once; downloadable template included
- **Per-drug thresholds** — each drug has its own low-stock alert threshold
- **Export CSV** — full inventory and sales exports from the Settings panel

### Dashboard
**Today's Operations**

| Card | Description |
|------|-------------|
| Today's Revenue | Revenue from sales made today |
| Today's Prescriptions | Prescriptions processed today |
| Pending | Incomplete prescriptions needing action |
| Fill Rate | % of completed prescriptions fully dispensed · ≥90% green · ≥70% amber · below red |

**Inventory Health**

| Card | Description |
|------|-------------|
| Out of Stock | Drugs with zero available units |
| Low Stock | Drugs below their individual alert threshold |
| Expiring ≤30 Days | Urgent — restock or discount needed |
| Expired Stock | Stock past expiry date — write-off required |

**Additional sections**
- **Needs Attention** — severity-sorted table (expired → out of stock → low stock → expiring) with context-aware action buttons: *Write Off*, *New Batch*, or *Restock*
- **Revenue Over Time** — line chart with Week / Month / All Time toggle; auto-refreshes every 60 seconds
- **Stock by Drug** — horizontal bar chart of current stock levels across all drugs
- **Restock Suggestions** — velocity-based predictions using 14-day sales history

### Analytics
**Sales Overview** — revenue over time, top 5 selling drugs, full per-drug breakdown table with revenue share bars

**Pharmacy Metrics**
- Prescription fill rate with outcome breakdown (sold / partial / cancelled)
- Stock turnover rate per drug (fast mover vs slow mover classification)
- Expiry loss summary — units and estimated value lost to write-offs by month
- Average prescription value trend over 30 days

### History
- **Prescriptions tab** — full upload history with outcome badges, image viewer, and Resume button for incomplete prescriptions
- **Orders tab** — sales transactions grouped by date with search, date-range filter, and CSV export

### Settings
Accessible via the gear icon from every page.

| Section | Description |
|---------|-------------|
| Security | Change the 4-digit PIN; all active sessions invalidated immediately |
| Data Export | Download inventory CSV or sales CSV |
| Data Reset | *Reset to Demo Data* reseeds 13 drugs + 21 days of history · *Clear Everything* wipes for production use |
| About | Version info and keyboard shortcut reference |

### Keyboard Shortcuts
`D` Dashboard · `N` New Prescription · `I` Inventory · `A` Analytics · `H` History · `?` Settings

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| AI | Google Gemini 2.5 Flash | Vision extraction via `google-genai` SDK |
| Backend | FastAPI 0.110+ | All API endpoints in `main.py` |
| Server | Uvicorn | ASGI server |
| Database | SQLite (`sqlite3`) | Built-in, no external DB needed |
| Fuzzy matching | `rapidfuzz` | Token sort ratio, threshold 80 |
| Frontend | Vanilla HTML / CSS / JS | No framework — single-page app |
| Charts | Chart.js 4.4.1 | Loaded from CDN |
| Icons | Lucide | Loaded from CDN |
| Image handling | `Pillow` | Prescription image processing |
| Config | `python-dotenv` | Environment variable management |
| Deployment | Docker on Hugging Face Spaces | |

---

## Project Structure

```
PharmAssistV2/
├── main.py                  # FastAPI app — all API endpoints + auth middleware
├── db_utils.py              # All database queries and business logic
├── rag_agent.py             # Gemini Vision prescription extraction (lazy-init)
├── app.py                   # Hugging Face Spaces entry point (uvicorn launcher)
├── Dockerfile               # Docker build instructions
├── .dockerignore            # Excludes secrets, venv, DB from Docker context
├── requirements.txt
├── .env                     # Local secrets — gitignored, never committed
├── .env.example             # Safe template — committed to repo
├── pharmacy.db              # SQLite DB — auto-created on startup, gitignored
│                            # Rebuilt from seed data on every cold start
├── seed_demo_data.py        # Standalone script for manual re-seeding (optional)
└── static/
    ├── index.html           # SPA shell — nav, page containers, script tags
    ├── css/
    │   └── app.css          # All styles and CSS variables
    └── js/
        ├── app.js           # Router, shared utilities, apiFetch, window exports
        ├── auth.js          # PIN login, session token, apiFetch monkey-patch
        ├── dashboard.js     # Dashboard page and KPI components
        ├── prescriptions.js # Full 4-step prescription flow
        ├── inventory.js     # Inventory CRUD and batch management
        ├── analytics.js     # Analytics charts and pharmacy metrics
        ├── history.js       # Prescription history and sales orders
        └── settings.js      # Global settings panel
```

---

## Database Schema

```sql
drugs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT    NOT NULL,
    brand               TEXT,
    price_per_unit      REAL    NOT NULL DEFAULT 0.0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 20
)

batches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id       INTEGER NOT NULL REFERENCES drugs(id),
    quantity      INTEGER NOT NULL DEFAULT 0,
    expiry_date   TEXT,
    received_date TEXT    NOT NULL,
    batch_note    TEXT,
    supplier      TEXT
)

sales (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id       INTEGER NOT NULL REFERENCES drugs(id),
    batch_id      INTEGER          REFERENCES batches(id),
    quantity_sold INTEGER NOT NULL,
    sale_date     TEXT    NOT NULL
)

prescription_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_date TEXT NOT NULL,
    image_data  BLOB,
    extracted   TEXT NOT NULL,   -- JSON array of medicine objects
    outcome     TEXT NOT NULL DEFAULT 'pending',
                                 -- sold | partial | cancelled | abandoned | pending
    notes       TEXT
)

writeoff_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id       INTEGER NOT NULL REFERENCES drugs(id),
    batch_id      INTEGER NOT NULL REFERENCES batches(id),
    quantity      INTEGER NOT NULL,
    expiry_date   TEXT,
    writeoff_date TEXT    NOT NULL,
    reason        TEXT    NOT NULL DEFAULT 'expired'
)
```

> `drugs.quantity` and `drugs.expiry_date` are never stored directly — they are always computed from the `batches` table via aggregation. Stock is consumed FIFO (oldest expiry first).

---

## Local Setup

### Prerequisites
- Python 3.11
- A free Google Gemini API key — [aistudio.google.com](https://aistudio.google.com)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-username/PharmAssistV2.git
cd PharmAssistV2

# 2. Create and activate a virtual environment
python3.11 -m venv venv
source venv/bin/activate        # macOS / Linux
# venv\Scripts\activate         # Windows

# 3. Install dependencies
pip install -r requirements.txt

# 4. Create your .env file from the template
cp .env.example .env
# Open .env and set your GEMINI_API_KEY
```

### Environment variables

```env
GEMINI_API_KEY=your_gemini_api_key_here
PHARMASSIST_PIN=1234
ALLOWED_ORIGINS=http://localhost:8000
```

### Run

```bash
uvicorn main:app --reload --port 8000
```

Open [http://localhost:8000](http://localhost:8000) and log in with PIN `1234`.

The database is created and seeded automatically on first startup — 13 prescription drugs, 21 days of sales history, and sample prescription records so the app looks fully functional immediately.

---

## Demo Data

| Drug | Stock | Scenario |
|------|-------|----------|
| Augmentin 625mg | 120 units | Normal full sale |
| Enzoflam | 6 units | Low stock · partial sale |
| Pan-D 40mg | 90 units | Expiring ≈25 days |
| Hexigel | 0 units | Out of stock · Add to Inventory & Return flow |
| Ultraflex Plus | 50 + 30 (2 batches) | FIFO batch deduction test |
| Relentas | 8 units | Low stock alert |
| Ultracal-D | 150 units | High-volume normal sale |
| Cartilix | 60 units | Normal sale |
| Diclofenac 50mg | 200 units | Expiring ≈60 days |
| Omeprazole Cap | 40 units | Already expired → write-off test |
| Bonphrozy 2mg | 50 units | Normal sale |
| Clonthogan | 60 units | Normal sale |
| Prednisolone | 5 units | Low stock alert |

---

## Deployment on Hugging Face Spaces

### 1. Create a new Space
Go to [huggingface.co/new-space](https://huggingface.co/new-space) and select **Docker** as the SDK.

### 2. Set Secrets before pushing
In your Space → **Settings → Variables and Secrets**:

| Secret | Value |
|--------|-------|
| `GEMINI_API_KEY` | Your Google Gemini API key |
| `PHARMASSIST_PIN` | A 4-digit PIN — change from the default `1234` |
| `ALLOWED_ORIGINS` | `https://YOUR-USERNAME-pharmassistv2.hf.space` |

### 3. Push to your Space

```bash
git init
git add .
git commit -m "Initial deployment"
git remote add space https://huggingface.co/spaces/YOUR-USERNAME/PharmAssistV2
git push space main
```

HF Spaces detects the `Dockerfile`, builds the image, and starts the container on port 7860.

### Ephemeral filesystem
HF Spaces resets the filesystem on every container restart. `pharmacy.db` is rebuilt automatically from seed data on cold start so the app always looks fully functional after a restart, but any data entered between restarts is lost. For persistent storage in a production environment, replace SQLite with a hosted database such as PostgreSQL.

---

## API Reference

All endpoints except `POST /api/auth/login` require a valid Bearer token.

```http
Authorization: Bearer <token>
```

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Validate PIN → session token · locked out after 5 failures for 5 minutes |
| `POST` | `/api/auth/logout` | Invalidate session token |
| `POST` | `/api/auth/pin` | Change PIN — requires valid session · clears all active sessions |

### Dashboard & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/dashboard` | KPIs, alerts, restock suggestions |
| `GET` | `/api/analytics` | Revenue, top drugs, daily breakdown |
| `GET` | `/api/analytics/pharmacy` | Fill rate, turnover, expiry loss, avg Rx value |

### Inventory
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/drugs` | Full drug list with aggregated stock |
| `POST` | `/api/drugs` | Add a new drug |
| `PUT` | `/api/drugs/{id}` | Edit drug details |
| `DELETE` | `/api/drugs/{id}` | Delete drug (blocked if has sales history) |
| `GET` | `/api/drugs/{id}/batches` | List batches in FIFO order |
| `POST` | `/api/drugs/{id}/restock` | Add a new stock batch |
| `DELETE` | `/api/batches/{id}` | Remove a depleted batch |
| `POST` | `/api/drugs/writeoff-expired` | Zero all expired batches and log write-offs |
| `GET` | `/api/drugs/expiry-timeline` | Batches grouped by expiry window |

### Prescriptions & Sales
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/prescriptions/extract` | Upload image → Gemini extraction |
| `POST` | `/api/prescriptions/check` | Check stock availability |
| `POST` | `/api/prescriptions/manual` | Save manually entered prescription |
| `POST` | `/api/prescriptions/{id}/cancel` | Cancel a prescription |
| `POST` | `/api/prescriptions/{id}/notes` | Update notes |
| `GET` | `/api/prescriptions/{id}/resume` | Resume a pending prescription |
| `POST` | `/api/sales` | Confirm sale — deducts stock FIFO |
| `GET` | `/api/sales` | Transaction log |

### History & Export
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/history` | Prescription upload history |
| `GET` | `/api/history/{id}/image` | Prescription image as base64 |
| `GET` | `/api/export/csv` | Inventory CSV download |
| `GET` | `/api/export/sales-csv` | Sales CSV download |

### Administration
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/reset/counts` | Row counts per category |
| `POST` | `/api/reset/selective` | `mode=demo` reseeds · `mode=clean` wipes |

---

## Security

| Measure | Implementation |
|---------|---------------|
| PIN comparison | `secrets.compare_digest()` — timing-safe |
| Session tokens | `secrets.token_hex(32)` — 256-bit entropy |
| Token validation | Every protected endpoint uses a FastAPI `Depends` guard |
| Brute-force protection | 5 failed attempts triggers a 5-minute IP lockout |
| Secrets management | All credentials from environment variables — nothing hardcoded |
| Docker | Container runs as a non-root user |

> **Portfolio note:** The PIN is stored as a plaintext environment variable. For production use with real patient data, the PIN should be hashed with PBKDF2 or bcrypt and stored in the database, and session storage should use Redis rather than an in-memory dict that resets on restart.

---

## Acknowledgements

- [Google Gemini](https://deepmind.google/technologies/gemini/) — handwritten prescription OCR and structured extraction
- [FastAPI](https://fastapi.tiangolo.com/) — Python web framework
- [Chart.js](https://www.chartjs.org/) — dashboard charts
- [Lucide](https://lucide.dev/) — icon library
- [rapidfuzz](https://github.com/rapidfuzz/RapidFuzz) — fuzzy drug name matching

---

## License

MIT — see `LICENSE` for details.

---

## Testing the App

Four test prescription images are included in the `test_prescriptions/` folder. Each one demonstrates a different scenario.

---

### Prescription 1 — The White Tusk Dental
`test_prescriptions/01_white_tusk_dental.jpg`

| Drug | Dosing | Duration | Qty Needed |
|------|--------|----------|------------|
| Augmentin 625mg | 1-0-1 (2/day) | 5 days | 10 tablets |
| Enzoflam | 1-0-1 (2/day) | 5 days | 10 tablets |
| Pan-D 40mg | 1-0-0 (1/day) | 5 days | 5 tablets |
| Hexigel gum paint | 1-0-1 (2/day) | 1 week | 14 units |

**What to expect:**
- Augmentin, Enzoflam, Pan-D → ✅ In stock — full sale
- Hexigel → ❌ Out of stock — triggers the **Add to Inventory & Return** flow
- Good demo of a partial sale and the not-found recovery flow

---

### Prescription 2 — Trauma Center
`test_prescriptions/02_trauma_center.jpg`

| Drug | Scenario |
|------|----------|
| Ultraflex Plus | ✅ In stock — 2 batches (FIFO deduction visible) |
| Relentas | ⚠️ Low stock |
| Bonphrozy 2mg | ✅ In stock |
| Ultracal-D | ✅ In stock |
| Cartilix | ✅ In stock |
| Diclofenac 50mg | ✅ In stock — expiring in ~60 days |
| Omeprazole Cap | ❌ Expired stock — shows expiry badge |

**What to expect:**
- Largest prescription — 7+ drugs
- Shows FIFO batch deduction on Ultraflex Plus (2 batches)
- Shows low stock warning on Relentas
- Shows expired badge on Omeprazole Cap
- Good demo of the full availability check table

---

### Prescription 3 — Dr. Norman Babar (Pediatrician)
`test_prescriptions/03_dr_babar_pediatric.jpg`

| Drug | Scenario |
|------|----------|
| Clonthogan | ✅ In stock |
| Prednisolone | ⚠️ Low stock (5 units) |

**What to expect:**
- Shortest prescription — 2 drugs
- Shows low stock warning on Prednisolone
- Good quick demo of a simple successful sale

---

### Prescription 4 — Not Found Test
`test_prescriptions/04_not_found_test.png`

| Drug | Scenario |
|------|----------|
| Amoxicillin 500mg | ❌ Not in inventory |

**What to expect:**
- Drug is not in the demo inventory
- Demonstrates the **"Add to Inventory & Return"** flow end-to-end
- Click the button → navigates to Inventory with name pre-filled → add the drug → automatically returns to prescription and re-checks availability
- Good demo of the fuzzy matching and not-found recovery

---

### Suggested demo order

For the best walkthrough when showing the app to someone:

1. **Start with Prescription 1** — clean, readable, shows the core flow
2. **Then Prescription 3** — quick 2-drug sale to show speed
3. **Then Prescription 2** — complex prescription showing FIFO, low stock, and expiry
4. **Finish with Prescription 4** — shows the not-found recovery flow as a wow moment

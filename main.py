"""
main.py
=======
FastAPI application entry point for PharmAssist V2.

All HTTP routing lives here. Business logic and data access are
delegated to db_utils.py and rag_agent.py respectively — this file
contains only request validation, response shaping, and HTTP error
mapping.

API surface
-----------
Dashboard
    GET  /api/dashboard                   KPIs, alerts, restock suggestions

Inventory
    GET  /api/drugs                       Full drug list
    POST /api/drugs                       Add a new drug
    PUT  /api/drugs/{id}                  Edit drug master data
    DELETE /api/drugs/{id}                Delete a drug (blocked if has sales)

Batches
    GET  /api/drugs/{id}/batches          Batch list for a drug (FIFO order)
    POST /api/drugs/{id}/restock          Add a new stock batch
    DELETE /api/batches/{id}              Remove a depleted batch

Stock operations
    POST /api/drugs/writeoff-expired      Zero expired batches, log write-offs
    GET  /api/drugs/expiry-timeline       Batches grouped by expiry window

Prescriptions
    POST /api/prescriptions/extract       Upload image -> Gemini extraction
    POST /api/prescriptions/check         Check availability for extracted drugs

Sales
    POST /api/sales                       Confirm sale, deduct stock (FIFO)
    GET  /api/sales                       Transaction log

Analytics
    GET  /api/analytics                   Revenue, top drugs, daily breakdown

History
    GET  /api/history                     Prescription upload history
    GET  /api/history/{id}/image          Raw prescription image as base64

Administration
    POST /api/reset                       Hard reset — wipe and re-seed

Static files
    /*                                    Served from ./static/ (SPA shell)
"""

from __future__ import annotations

import base64
import json
import os
import secrets
from contextlib import asynccontextmanager
from datetime import date
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

import db_utils
from rag_agent import extract_prescription


# ---------------------------------------------------------------------------
# Application lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialise the database schema and seed data on startup."""
    db_utils.init_db()
    # Mark any pending prescriptions older than 24 hours as abandoned
    abandoned = db_utils.mark_abandoned_prescriptions(stale_hours=24)
    if abandoned:
        print(f"[startup] Marked {abandoned} stale prescription(s) as abandoned.")
    yield


app = FastAPI(
    title       = "PharmAssist V2",
    description = "AI-powered pharmacy management — prescription scanning, "
                  "batch-tracked inventory, and sales analytics.",
    version     = "2.0.0",
    lifespan    = lifespan,
)

_ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:8000").split(",")
app.add_middleware(CORSMiddleware, allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True, allow_methods=["GET","POST","PUT","DELETE"], allow_headers=["*"])


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

_active_sessions: dict[str, bool] = {}

# Brute-force protection: track failed attempts per IP
_failed_attempts: dict[str, list] = {}
_MAX_ATTEMPTS   = 5    # max failures before lockout
_LOCKOUT_SECS   = 300  # 5-minute lockout window

_bearer = HTTPBearer(auto_error=False)


def _require_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> str:
    """
    Dependency that validates the Bearer token on every protected endpoint.
    Raises 401 if the token is missing or not in _active_sessions.
    """
    token = credentials.credentials if credentials else None
    if not token or token not in _active_sessions:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    return token


class LoginRequest(BaseModel):
    pin: str


class ChangePINRequest(BaseModel):
    new_pin: str


class ManualPrescriptionRequest(BaseModel):
    medicines: list[dict]


@app.post("/api/auth/login", summary="Authenticate with PIN")
def login(body: LoginRequest, request: Request) -> dict:
    """Validate PIN and return a session token. Locked out after 5 failures for 5 minutes."""
    import time
    client_ip = request.client.host if request.client else "unknown"
    now       = time.time()

    # Clean up attempts outside the lockout window
    attempts = _failed_attempts.get(client_ip, [])
    attempts = [t for t in attempts if now - t < _LOCKOUT_SECS]

    if len(attempts) >= _MAX_ATTEMPTS:
        wait = int(_LOCKOUT_SECS - (now - attempts[0]))
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed attempts. Try again in {wait} seconds.",
        )

    expected = os.getenv("PHARMASSIST_PIN", "1234")
    if not secrets.compare_digest(body.pin.strip(), expected):
        attempts.append(now)
        _failed_attempts[client_ip] = attempts
        remaining = _MAX_ATTEMPTS - len(attempts)
        raise HTTPException(
            status_code=401,
            detail=f"Invalid PIN. {remaining} attempt{'s' if remaining != 1 else ''} remaining.",
        )

    # Successful login — clear failed attempts for this IP
    _failed_attempts.pop(client_ip, None)
    token = secrets.token_hex(32)
    _active_sessions[token] = True
    return {"token": token}


@app.post("/api/auth/logout", summary="Invalidate session token")
def api_logout(request: Request) -> dict:
    token = (request.headers.get("Authorization") or "").replace("Bearer ", "")
    _active_sessions.pop(token, None)
    return {"success": True}


@app.post("/api/auth/pin", summary="Change the application PIN")
def change_pin(body: ChangePINRequest, _token: str = Depends(_require_auth)) -> dict:
    """Change PIN. Requires a valid session. Clears all active sessions after change."""
    new_pin = body.new_pin.strip()
    if not new_pin.isdigit() or len(new_pin) != 4:
        raise HTTPException(status_code=400, detail="PIN must be exactly 4 digits.")
    os.environ["PHARMASSIST_PIN"] = new_pin
    _active_sessions.clear()
    return {"success": True}


@app.post("/api/prescriptions/manual", summary="Save a manually entered prescription")
def save_manual_prescription(body: ManualPrescriptionRequest, _token: str = Depends(_require_auth)) -> dict:
    record_id = db_utils.save_prescription(b"", body.medicines, outcome="pending", notes="manual")
    return {"prescription_id": record_id}


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class AddDrugRequest(BaseModel):
    """Payload for POST /api/drugs."""
    name:                str
    brand:               str   = ""
    quantity:            int   = Field(default=0,  ge=0)
    expiry_date:         str   = ""
    price_per_unit:      float = Field(default=0.0, ge=0.0)
    low_stock_threshold: int   = Field(default=20, ge=1)


class EditDrugRequest(BaseModel):
    """Payload for PUT /api/drugs/{id}. Stock changes use the restock endpoint."""
    name:                str
    brand:               str   = ""
    price_per_unit:      float = Field(default=0.0, ge=0.0)
    low_stock_threshold: int   = Field(default=20, ge=1)


class RestockRequest(BaseModel):
    """Payload for POST /api/drugs/{id}/restock. Creates one new batch row."""
    quantity_added: int   = Field(..., ge=1)
    expiry_date:    str   = ""
    batch_note:     str   = ""
    supplier:       str   = ""


class CheckItem(BaseModel):
    """A single medicine from a prescription to check against inventory."""
    drug_name:         str
    frequency:         Optional[int] = None
    duration:          Optional[int] = None
    required_quantity: Optional[int] = None


class SaleItem(BaseModel):
    """A single line item in a sale confirmation."""
    drug_id:       int
    drug_name:     str
    quantity_sold: int = Field(..., ge=1)


class ConfirmSaleRequest(BaseModel):
    """Payload for POST /api/sales."""
    items:             list[SaleItem]
    prescription_id:   Optional[int] = None
    total_prescribed:  Optional[int] = None  # total drugs on the prescription


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_alerts(
    expired:   list[dict],
    low_stock: list[dict],
    expiring:  list[dict],
) -> list[dict]:
    """
    Compile a unified alert list from the three alert data sources.

    Alerts are ordered by severity: expired first, then out-of-stock,
    then low stock, then upcoming expiries.
    """
    alerts: list[dict] = []

    for drug in expired:
        alerts.append({
            "type":    "expired",
            "level":   "danger",
            "drug_id": drug["id"],
            "name":    drug["name"],
            "message": (
                f"{drug['name']} has expired stock "
                f"(expiry: {drug['expiry_date']})"
            ),
        })

    for drug in low_stock:
        out_of_stock = drug["quantity"] == 0
        alerts.append({
            "type":    "out_of_stock" if out_of_stock else "low_stock",
            "level":   "danger" if out_of_stock else "warning",
            "drug_id": drug["id"],
            "name":    drug["name"],
            "message": (
                f"{drug['name']} is out of stock"
                if out_of_stock else
                f"{drug['name']} has only {drug['quantity']} units "
                f"(threshold: {drug['low_stock_threshold']})"
            ),
        })

    for drug in expiring:
        alerts.append({
            "type":    "expiring",
            "level":   "warning",
            "drug_id": drug["id"],
            "name":    drug["name"],
            "message": f"{drug['name']} expires on {drug['expiry_date']}",
        })

    return alerts


def _availability_status(found: bool, sufficient: bool) -> str:
    """Map a found/sufficient pair to a display status string."""
    if not found:
        return "not_found"
    return "sufficient" if sufficient else "insufficient"


def _prescription_outcome(results: list[dict], total_prescribed: int = 0) -> str:
    """
    Derive the prescription outcome from sale results.

    A sale is 'partial' when:
      - Some submitted items failed (stock error), OR
      - The pharmacist only submitted a subset of the prescribed drugs
        (total_prescribed > number of items submitted and succeeded)

    This ensures that selling 1 out of 4 prescribed drugs correctly
    records as 'partial' rather than 'sold'.
    """
    succeeded = sum(1 for r in results if r["success"])
    any_ok    = succeeded > 0

    # If we know the total prescribed count, use it to detect partial fills
    # where the pharmacist deselected some drugs before confirming
    if total_prescribed and total_prescribed > 0:
        all_ok = any_ok and succeeded >= total_prescribed
    else:
        all_ok = all(r["success"] for r in results)

    if all_ok:
        return "sold"
    return "partial" if any_ok else "cancelled"


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@app.get("/api/dashboard", summary="Dashboard KPIs, alerts, and restock suggestions")
def get_dashboard(_token: str = Depends(_require_auth)) -> dict:
    """
    Return all data required to render the dashboard in a single request.

    Response shape:
        kpis    — headline metrics (see get_dashboard_kpis)
        alerts  — ordered list of stock and expiry warnings
        restock — drugs predicted to run out based on recent velocity
    """
    try:
        kpis     = db_utils.get_dashboard_kpis()
        expiring = db_utils.get_expiring_drugs(days_threshold=90)
        expired  = db_utils.get_expired_drugs()
        low      = db_utils.get_low_stock_drugs()
        restock  = db_utils.get_restock_suggestions()
        alerts   = _build_alerts(expired, low, expiring)
        return {"kpis": kpis, "alerts": alerts, "restock": restock}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Inventory — drugs
# ---------------------------------------------------------------------------

@app.get("/api/drugs", summary="Full inventory list")
def get_drugs(_token: str = Depends(_require_auth)) -> list:
    """Return all drugs sorted alphabetically, enriched with batch aggregates."""
    try:
        return db_utils.get_all_drugs()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/drugs", status_code=201, summary="Add a new drug")
def add_drug(body: AddDrugRequest, _token: str = Depends(_require_auth)) -> dict:
    """
    Insert a new drug into inventory.

    If quantity > 0 an initial batch is created automatically using the
    supplied expiry_date. Rejects duplicate names (case-insensitive).
    """
    result = db_utils.add_new_drug(
        body.name,
        body.brand,
        body.quantity,
        body.expiry_date,
        body.price_per_unit,
        body.low_stock_threshold,
    )
    if not result["success"]:
        raise HTTPException(
            status_code=409,
            detail={
                "reason":  result["reason"],
                "message": f"A drug named '{body.name}' already exists in inventory.",
            },
        )
    return {"success": True, "id": result["id"]}


@app.put("/api/drugs/{drug_id}", summary="Edit drug master data")
def edit_drug(drug_id: int, body: EditDrugRequest, _token: str = Depends(_require_auth)) -> dict:
    """
    Update a drug's name, brand, price, and alert threshold.

    Stock and expiry are managed through the batches endpoints.
    Returns the updated drug record on success.
    """
    success = db_utils.update_drug(
        drug_id,
        body.name,
        body.brand,
        body.price_per_unit,
        body.low_stock_threshold,
    )
    if not success:
        raise HTTPException(status_code=404, detail=f"Drug {drug_id} not found.")
    return {"success": True, "drug": db_utils.get_drug_by_id(drug_id)}


@app.delete("/api/drugs/{drug_id}", summary="Delete a drug")
def delete_drug(drug_id: int, _token: str = Depends(_require_auth)) -> dict:
    """
    Remove a drug and all its batches from inventory.

    Returns 409 if the drug has sales records — deletion would break
    historical transaction data. Deactivate the drug instead.
    """
    result = db_utils.delete_drug(drug_id)
    if not result["success"]:
        if result["reason"] == "not_found":
            raise HTTPException(status_code=404, detail=f"Drug {drug_id} not found.")
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot delete this drug — it has sales history. "
                "Remove all associated sales first, or deactivate it instead."
            ),
        )
    return {"success": True}


# ---------------------------------------------------------------------------
# Inventory — batches
# ---------------------------------------------------------------------------

@app.get("/api/drugs/{drug_id}/batches", summary="List batches for a drug")
def get_batches(drug_id: int, _token: str = Depends(_require_auth)) -> list:
    """
    Return all batches for the given drug in FIFO order (oldest expiry first).
    Includes both active and depleted batches.
    """
    return db_utils.get_batches_for_drug(drug_id)


@app.post("/api/drugs/{drug_id}/restock", summary="Add a new stock batch")
def restock_drug(drug_id: int, body: RestockRequest, _token: str = Depends(_require_auth)) -> dict:
    """
    Create a new batch for an existing drug.

    Each restock call produces exactly one new batch row. The new batch
    will be consumed after all earlier-expiring batches when stock is
    deducted (FIFO). Returns the updated drug and full batch list.
    """
    success = db_utils.restock_drug(
        drug_id,
        body.quantity_added,
        body.expiry_date,
        body.batch_note,
        body.supplier,
    )
    if not success:
        raise HTTPException(status_code=404, detail=f"Drug {drug_id} not found.")
    return {
        "success": True,
        "drug":    db_utils.get_drug_by_id(drug_id),
        "batches": db_utils.get_batches_for_drug(drug_id),
    }


@app.delete("/api/batches/{batch_id}", summary="Remove a depleted batch")
def delete_batch(batch_id: int, _token: str = Depends(_require_auth)) -> dict:
    """
    Delete a batch record. Only depleted batches (quantity = 0) should
    be deleted; active batches should never be removed manually.

    Returns 409 if the batch has sales records attached.
    """
    result = db_utils.delete_batch(batch_id)
    if not result["success"]:
        if result["reason"] == "not_found":
            raise HTTPException(status_code=404, detail=f"Batch {batch_id} not found.")
        raise HTTPException(
            status_code=409,
            detail="Cannot delete this batch — it has associated sales records.",
        )
    return {"success": True}


# ---------------------------------------------------------------------------
# Stock operations
# ---------------------------------------------------------------------------

@app.post("/api/drugs/writeoff-expired", summary="Write off all expired stock")
def writeoff_expired(_token: str = Depends(_require_auth)) -> dict:
    """
    Zero the quantity of every batch that has passed its expiry date and
    still holds stock. Each write-off is recorded in the writeoff_log
    table for audit purposes.

    Returns a summary including the number of batches and total units
    written off.
    """
    try:
        return db_utils.writeoff_expired_batches()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/drugs/expiry-timeline", summary="Batches grouped by expiry window")
def expiry_timeline(_token: str = Depends(_require_auth)) -> dict:
    """
    Return active batches grouped into four time buckets:
        already_expired — past expiry date with stock remaining
        within_30_days  — expiring in 0–30 days
        within_60_days  — expiring in 31–60 days
        within_90_days  — expiring in 61–90 days
    """
    try:
        return db_utils.get_expiry_timeline()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Prescriptions
# ---------------------------------------------------------------------------

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}


@app.post("/api/prescriptions/extract", summary="Extract medicines from a prescription image")
async def extract_prescription_endpoint(file: UploadFile = File(...), _token: str = Depends(_require_auth)) -> dict:
    """
    Accept a prescription image upload and pass it to Gemini Vision for
    structured extraction of drug names, dosing frequencies, and durations.

    The prescription is saved to history with outcome 'pending'. The
    caller should update the outcome via confirm_sale once dispensed.

    Returns:
        prescription_id — ID of the saved prescription_history record
        medicines       — list of extracted medicine dicts
        image_b64       — base64-encoded image for client-side preview
        count           — number of medicines extracted
    """
    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=415,
            detail=(
                f"Unsupported file type '{file.content_type}'. "
                "Please upload a JPEG, PNG, or WebP image."
            ),
        )

    image_bytes = await file.read()

    try:
        medicines = extract_prescription(image_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        msg = str(exc)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower():
            raise HTTPException(
                status_code=429,
                detail="Gemini API quota exhausted. Resets daily at midnight Pacific Time.",
            ) from exc
        if "503" in msg or "unavailable" in msg.lower():
            raise HTTPException(
                status_code=503,
                detail="Gemini temporarily unavailable. Please try again shortly.",
            ) from exc
        raise HTTPException(
            status_code=500,
            detail=f"Gemini extraction failed: {exc}",
        ) from exc

    record_id = db_utils.save_prescription(image_bytes, medicines)
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    return {
        "prescription_id": record_id,
        "medicines":       medicines,
        "image_b64":       image_b64,
        "count":           len(medicines),
    }


@app.post("/api/prescriptions/check", summary="Check stock availability for extracted medicines")
def check_availability(items: list[CheckItem], _token: str = Depends(_require_auth)) -> list:
    """
    Match a list of extracted medicines against the inventory.

    Each item is looked up by exact name first, then by fuzzy match if
    no exact result is found. Returns each input item enriched with
    availability status, matched drug record, and fuzzy match metadata.

    Status values:
        sufficient   — drug found, stock meets the required quantity
        insufficient — drug found, stock is below required quantity
        not_found    — no drug matched (exact or fuzzy)
    """
    results = []
    for item in items:
        required = item.required_quantity or (
            ((item.frequency or 0) * (item.duration or 0)) or None
        )
        avail = db_utils.check_availability(item.drug_name, required or 0)
        results.append({
            "drug_name":         item.drug_name,
            "frequency":         item.frequency,
            "duration":          item.duration,
            "required_quantity": required,
            "found":             avail["found"],
            "sufficient":        avail["sufficient"],
            "fuzzy_match":       avail["fuzzy_match"],
            "matched_name":      avail["matched_name"],
            "drug":              avail["drug"],
            "status":            _availability_status(avail["found"], avail["sufficient"]),
        })
    return results


# ---------------------------------------------------------------------------
# Sales
# ---------------------------------------------------------------------------

@app.post("/api/sales", status_code=201, summary="Confirm a sale and deduct stock")
def confirm_sale(body: ConfirmSaleRequest, _token: str = Depends(_require_auth)) -> dict:
    """
    Process a sale by deducting stock for each line item using FIFO batch
    consumption. If a prescription_id is supplied the prescription outcome
    is updated to reflect whether all, some, or none of the items were
    successfully dispensed.

    Returns:
        success — True if every item was dispensed successfully
        partial — True if some (but not all) items succeeded
        results — per-item deduction outcome
    """
    if not body.items:
        raise HTTPException(status_code=400, detail="The sale must contain at least one item.")

    results = [
        {
            "drug_id":   item.drug_id,
            "drug_name": item.drug_name,
            "quantity":  item.quantity_sold,
            "success":   db_utils.deduct_stock(item.drug_id, item.quantity_sold),
        }
        for item in body.items
    ]

    all_ok = all(r["success"] for r in results)
    any_ok = any(r["success"] for r in results)

    if body.prescription_id:
        db_utils.update_prescription_outcome(
            body.prescription_id,
            _prescription_outcome(results, body.total_prescribed or 0),
        )

    return {
        "success": all_ok,
        "partial": any_ok and not all_ok,
        "results": results,
    }


@app.get("/api/sales", summary="Sales transaction log")
def get_sales(limit: int = 100, _token: str = Depends(_require_auth)) -> list:
    """
    Return the most recent sales records, newest first.

    Args:
        limit: Maximum number of records to return (default 100).
    """
    return db_utils.get_sales_log(limit=limit)


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

@app.get("/api/analytics", summary="Revenue and sales analytics")
def get_analytics(_token: str = Depends(_require_auth)) -> dict:
    """
    Return all data needed to render the Analytics page.

    Response shape:
        summary   — total revenue, transactions, and units sold
        top_drugs — top 5 drugs by units sold
        by_date   — daily revenue and unit totals (for line chart)
        by_drug   — per-drug revenue breakdown (for bar chart and table)
    """
    return {
        "summary":   db_utils.get_sales_summary(),
        "top_drugs": db_utils.get_top_selling_drugs(limit=5),
        "by_date":   db_utils.get_sales_by_date(),
        "by_drug":   db_utils.get_sales_by_drug(),
    }


# ---------------------------------------------------------------------------
# Prescription history
# ---------------------------------------------------------------------------

@app.post("/api/prescriptions/{record_id}/cancel", summary="Cancel a prescription")
def cancel_prescription(record_id: int, _token: str = Depends(_require_auth)) -> dict:
    """Mark a prescription as cancelled without creating any sale record."""
    updated = db_utils.update_prescription_outcome(record_id, "cancelled")
    if not updated:
        raise HTTPException(status_code=404, detail=f"Prescription {record_id} not found.")
    return {"success": True}


@app.post("/api/prescriptions/{record_id}/notes", summary="Update prescription notes")
def update_prescription_notes(record_id: int, body: dict, _token: str = Depends(_require_auth)) -> dict:
    """Store free-text notes on a prescription record (used for duplicate detection)."""
    conn = db_utils.get_connection()
    conn.execute(
        "UPDATE prescription_history SET notes = ? WHERE id = ?",
        (body.get("notes", ""), record_id),
    )
    conn.commit()
    conn.close()
    return {"success": True}


@app.get("/api/prescriptions/{record_id}/resume", summary="Resume a pending or abandoned prescription")
def resume_prescription(record_id: int, _token: str = Depends(_require_auth)) -> dict:
    """
    Return the extracted medicines and image for a pending or abandoned
    prescription so the pharmacist can resume the dispensing flow.

    Resets the outcome to 'pending' so the record is not immediately
    re-marked as abandoned while the pharmacist is working on it.
    """
    conn = db_utils.get_connection()
    cur  = conn.cursor()
    cur.execute(
        "SELECT extracted, image_data, outcome FROM prescription_history WHERE id = ?",
        (record_id,),
    )
    row = cur.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail=f"Prescription {record_id} not found.")

    medicines = json.loads(row[0]) if row[0] else []
    image_b64 = base64.b64encode(row[1]).decode("utf-8") if row[1] else None

    # Reset to pending so it stays active while the pharmacist works on it
    db_utils.update_prescription_outcome(record_id, "pending")

    return {
        "prescription_id": record_id,
        "medicines":       medicines,
        "image_b64":       image_b64,
        "count":           len(medicines),
    }


@app.get("/api/analytics/pharmacy", summary="Pharmacy-specific analytics")
def get_pharmacy_analytics(_token: str = Depends(_require_auth)) -> dict:
    try:
        return {
            "fill_rate":    db_utils.get_prescription_fill_rate(),
            "turnover":     db_utils.get_stock_turnover(),
            "expiry_loss":  db_utils.get_expiry_loss_summary(),
            "avg_rx_value": db_utils.get_avg_prescription_value(),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/export/csv", summary="Export inventory as CSV")
def export_inventory_csv(_token: str = Depends(_require_auth)) -> dict:
    drugs  = db_utils.get_all_drugs()
    header = "id,name,brand,quantity,expiry_date,low_stock_threshold,price_per_unit"
    rows   = []
    for d in drugs:
        name  = str(d["name"]).replace('"', '""')
        brand = str(d["brand"] or "").replace('"', '""')
        rows.append(
            f'{d["id"]},"{name}","{brand}",'
            f'{d["quantity"]},{d.get("expiry_date","")},{d["low_stock_threshold"]},'
            f'{d["price_per_unit"]}'
        )
    return {"csv": "\n".join([header] + rows),
            "filename": f"pharmassist_inventory_{date.today()}.csv"}


@app.get("/api/export/sales-csv", summary="Export sales log as CSV")
def export_sales_csv(_token: str = Depends(_require_auth)) -> dict:
    sales  = db_utils.get_sales_log(limit=10000)
    header = "id,date,drug_name,brand,quantity_sold,total_price,batch_expiry"
    rows   = []
    for s in sales:
        name  = str(s["name"]).replace('"', '""')
        brand = str(s["brand"] or "").replace('"', '""')
        rows.append(
            f'{s["id"]},{s["sale_date"]},"{name}","{brand}",'
            f'{s["quantity_sold"]},{s["total_price"]},{s.get("batch_expiry","")}'
        )
    return {"csv": "\n".join([header] + rows),
            "filename": f"pharmassist_sales_{date.today()}.csv"}


@app.get("/api/reset/counts", summary="Row counts per resettable category")
def get_reset_counts(_token: str = Depends(_require_auth)) -> dict:
    return db_utils.get_data_counts()


class ResetRequest(BaseModel):
    mode:    str = "demo"
    confirm: str = ""


@app.post("/api/reset/selective", summary="Reset database — demo or clean")
def reset_selective(body: ResetRequest, _token: str = Depends(_require_auth)) -> dict:
    if body.confirm != "RESET":
        raise HTTPException(status_code=400, detail="Send confirm='RESET' to proceed.")
    if body.mode == "demo":
        db_utils.reset_db()
        return {"success": True, "mode": "demo", "message": "Reset to demo data complete."}
    elif body.mode == "clean":
        db_utils.clear_all_data()
        return {"success": True, "mode": "clean", "message": "Database cleared."}
    else:
        raise HTTPException(status_code=400, detail="mode must be 'demo' or 'clean'.")


# Add startup GEMINI_API_KEY guard (A12)
# Already handled in lifespan startup log — key absence causes rag_agent import error


@app.get("/api/history", summary="Prescription upload history")
def get_history(limit: int = 50, _token: str = Depends(_require_auth)) -> list:
    """
    Return recent prescription uploads ordered newest first.
    Image blobs are excluded; use /api/history/{id}/image for images.

    Args:
        limit: Maximum number of records to return (default 50).
    """
    return db_utils.get_prescription_history(limit=limit)


@app.get("/api/history/{record_id}/image", summary="Prescription image as base64")
def get_prescription_image(record_id: int, _token: str = Depends(_require_auth)) -> dict:
    """
    Return the raw prescription image for a history record encoded as
    a base64 string for display in the browser.
    """
    image_bytes = db_utils.get_prescription_image(record_id)
    if not image_bytes:
        raise HTTPException(
            status_code=404,
            detail=f"No image found for prescription {record_id}.",
        )
    return {"image_b64": base64.b64encode(image_bytes).decode("utf-8")}


# ---------------------------------------------------------------------------
# Administration
# ---------------------------------------------------------------------------

@app.post("/api/reset", summary="Hard reset — wipe all data and re-seed")
def reset_database(confirm: str = Form(...), _token: str = Depends(_require_auth)) -> dict:
    """
    Delete all rows from every table and re-seed the 10 sample drugs.

    Requires the caller to submit confirm=RESET in the request body as
    an explicit acknowledgement that all data will be permanently lost.
    """
    if confirm != "RESET":
        raise HTTPException(
            status_code=400,
            detail="Confirmation required. Submit confirm=RESET to proceed.",
        )
    db_utils.reset_db()
    return {"success": True, "message": "Database reset and re-seeded successfully."}


# ---------------------------------------------------------------------------
# Static files — must be mounted last to avoid shadowing API routes
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory="static", html=True), name="static")
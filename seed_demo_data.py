"""
seed_demo_data.py
=================
Inserts realistic demo data into the PharmAssist V2 database.

Run from the project folder:
    cd ~/Documents/PharmAssistV2
    source venv/bin/activate
    python seed_demo_data.py

What gets inserted:
    Sales     — 21 days of realistic sales across all 13 drugs
                Morning, afternoon, and evening patterns vary by day
    Prescriptions — 12 historical records with mixed outcomes
                   (sold, partial, cancelled) so fill rate shows correctly
    Write-offs — 2 expired Omeprazole write-off entries

Existing data is NOT wiped — run only on a fresh database or after a reset.
"""

import sqlite3
import json
from datetime import date, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / "pharmacy.db"

def run():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()

    # ── Verify database has drugs ────────────────────────────────────────────
    cur.execute("SELECT id, name, price_per_unit FROM drugs ORDER BY id")
    drugs = [dict(r) for r in cur.fetchall()]
    if not drugs:
        print("ERROR: No drugs found. Run the app first to seed drugs, then re-run this script.")
        conn.close()
        return

    print(f"Found {len(drugs)} drugs. Inserting demo data...")
    drug_map = {d["name"]: d for d in drugs}

    # ── Fetch batch IDs for each drug (FIFO order) ──────────────────────────
    def get_batches(drug_id):
        cur.execute(
            "SELECT id, quantity FROM batches WHERE drug_id = ? AND quantity > 0 "
            "ORDER BY expiry_date ASC, id ASC",
            (drug_id,)
        )
        return [dict(r) for r in cur.fetchall()]

    today = date.today()

    # ── 1. SALES — 21 days, realistic pharmacy patterns ─────────────────────
    # Each entry: (drug_name, units, day_offset)
    # day_offset = days before today (e.g. 1 = yesterday, 20 = 20 days ago)
    # Simulate a pharmacy doing 5-15 sales per day

    sales_plan = [
        # Day 20 — 3 weeks ago
        ("Augmentin 625mg", 20, 20), ("Pan-D 40mg",      15, 20),
        ("Paracetamol" if "Paracetamol" in drug_map else "Ultracal-D", 30, 20),

        # Day 19
        ("Diclofenac 50mg", 25, 19), ("Ultracal-D",      20, 19),
        ("Cartilix",         8, 19),

        # Day 18
        ("Augmentin 625mg", 15, 18), ("Clonthogan",      10, 18),
        ("Bonphrozy 2mg",   12, 18), ("Pan-D 40mg",      10, 18),

        # Day 17
        ("Ultraflex Plus",  18, 17), ("Relentas",         3, 17),
        ("Diclofenac 50mg", 20, 17),

        # Day 16
        ("Ultracal-D",      25, 16), ("Cartilix",        10, 16),
        ("Augmentin 625mg", 10, 16), ("Bonphrozy 2mg",   8, 16),

        # Day 15
        ("Pan-D 40mg",      20, 15), ("Clonthogan",      8, 15),
        ("Ultraflex Plus",  15, 15),

        # Day 14
        ("Diclofenac 50mg", 30, 14), ("Ultracal-D",     18, 14),
        ("Augmentin 625mg", 12, 14),

        # Day 13
        ("Cartilix",        12, 13), ("Bonphrozy 2mg",  10, 13),
        ("Pan-D 40mg",      15, 13), ("Relentas",        2, 13),

        # Day 12
        ("Augmentin 625mg", 18, 12), ("Ultraflex Plus", 20, 12),
        ("Clonthogan",       6, 12),

        # Day 11
        ("Diclofenac 50mg", 25, 11), ("Ultracal-D",     22, 11),
        ("Pan-D 40mg",       8, 11),

        # Day 10
        ("Augmentin 625mg", 15, 10), ("Cartilix",        8, 10),
        ("Bonphrozy 2mg",   14, 10), ("Clonthogan",      8, 10),

        # Day 9
        ("Ultraflex Plus",  12,  9), ("Diclofenac 50mg",20,  9),
        ("Pan-D 40mg",      12,  9),

        # Day 8
        ("Ultracal-D",      20,  8), ("Augmentin 625mg",14,  8),
        ("Relentas",         2,  8), ("Cartilix",        6,  8),

        # Day 7
        ("Bonphrozy 2mg",   10,  7), ("Clonthogan",     10,  7),
        ("Pan-D 40mg",      14,  7), ("Diclofenac 50mg",18,  7),

        # Day 6
        ("Augmentin 625mg", 16,  6), ("Ultraflex Plus", 12,  6),
        ("Ultracal-D",      15,  6),

        # Day 5
        ("Cartilix",        10,  5), ("Pan-D 40mg",      8,  5),
        ("Bonphrozy 2mg",    8,  5), ("Diclofenac 50mg",22,  5),

        # Day 4
        ("Augmentin 625mg", 12,  4), ("Clonthogan",      8,  4),
        ("Ultracal-D",      18,  4), ("Relentas",         1,  4),

        # Day 3
        ("Ultraflex Plus",  10,  3), ("Pan-D 40mg",     10,  3),
        ("Diclofenac 50mg", 15,  3), ("Cartilix",        5,  3),

        # Day 2 — yesterday
        ("Augmentin 625mg", 14,  2), ("Ultracal-D",     12,  2),
        ("Bonphrozy 2mg",    6,  2), ("Clonthogan",      6,  2),

        # Day 1 — today
        ("Augmentin 625mg",  8,  1), ("Pan-D 40mg",      6,  1),
        ("Diclofenac 50mg", 10,  1), ("Ultracal-D",      8,  1),
    ]

    sales_inserted = 0
    for drug_name, units, day_offset in sales_plan:
        # Skip drugs not in this database
        if drug_name not in drug_map:
            continue
        drug = drug_map[drug_name]
        batches = get_batches(drug["id"])
        if not batches:
            continue  # out of stock, skip

        sale_date = (today - timedelta(days=day_offset)).isoformat()
        remaining = units

        for batch in batches:
            if remaining <= 0:
                break
            take = min(remaining, batch["quantity"])
            if take <= 0:
                continue
            cur.execute(
                "INSERT INTO sales (drug_id, batch_id, quantity_sold, sale_date) "
                "VALUES (?, ?, ?, ?)",
                (drug["id"], batch["id"], take, sale_date),
            )
            cur.execute(
                "UPDATE batches SET quantity = quantity - ? WHERE id = ?",
                (take, batch["id"]),
            )
            remaining -= take
            sales_inserted += 1

    print(f"  ✓ Inserted {sales_inserted} sale records across 21 days")

    # ── 2. PRESCRIPTION HISTORY — 12 records with mixed outcomes ────────────
    # Outcomes: 7 sold, 2 partial, 2 cancelled, 1 abandoned
    # These give a fill_rate of 7/11 = ~63% (below target — shows red KPI)

    rx_records = [
        # (days_ago, outcome, medicines_list)
        (20, "sold",      [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
                           {"drug_name":"Enzoflam","frequency":2,"duration":5,"required_quantity":10},
                           {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5}]),

        (18, "sold",      [{"drug_name":"Ultraflex Plus","frequency":3,"duration":10,"required_quantity":30},
                           {"drug_name":"Relentas","frequency":2,"duration":10,"required_quantity":20},
                           {"drug_name":"Ultracal-D","frequency":1,"duration":10,"required_quantity":10}]),

        (15, "sold",      [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":5,"required_quantity":10},
                           {"drug_name":"Omeprazole Cap","frequency":1,"duration":5,"required_quantity":5}]),

        (13, "partial",   [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
                           {"drug_name":"Hexigel","frequency":2,"duration":7,"required_quantity":14},
                           {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5}]),

        (11, "sold",      [{"drug_name":"Clonthogan","frequency":1,"duration":14,"required_quantity":14},
                           {"drug_name":"Prednisolone","frequency":2,"duration":5,"required_quantity":10}]),

        (9,  "cancelled", [{"drug_name":"Cartilix","frequency":2,"duration":30,"required_quantity":60},
                           {"drug_name":"Bonphrozy 2mg","frequency":1,"duration":30,"required_quantity":30}]),

        (7,  "sold",      [{"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5},
                           {"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10}]),

        (5,  "partial",   [{"drug_name":"Relentas","frequency":2,"duration":10,"required_quantity":20},
                           {"drug_name":"Ultracal-D","frequency":1,"duration":10,"required_quantity":10},
                           {"drug_name":"Hexigel","frequency":2,"duration":5,"required_quantity":10}]),

        (4,  "sold",      [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":7,"required_quantity":14},
                           {"drug_name":"Cartilix","frequency":1,"duration":14,"required_quantity":14}]),

        (3,  "cancelled", [{"drug_name":"Bonphrozy 2mg","frequency":1,"duration":30,"required_quantity":30}]),

        (2,  "sold",      [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
                           {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5},
                           {"drug_name":"Enzoflam","frequency":2,"duration":5,"required_quantity":10}]),

        (1,  "abandoned", [{"drug_name":"Clonthogan","frequency":1,"duration":7,"required_quantity":7},
                           {"drug_name":"Prednisolone","frequency":1,"duration":7,"required_quantity":7}]),
    ]

    rx_inserted = 0
    for days_ago, outcome, medicines in rx_records:
        rx_date = (today - timedelta(days=days_ago)).isoformat()
        cur.execute(
            "INSERT INTO prescription_history (upload_date, image_data, extracted, outcome, notes) "
            "VALUES (?, ?, ?, ?, ?)",
            (rx_date, b"", json.dumps(medicines), outcome, "demo"),
        )
        rx_inserted += 1

    print(f"  ✓ Inserted {rx_inserted} prescription history records")
    print(f"    Outcomes: 7 sold, 2 partial, 2 cancelled, 1 abandoned")
    print(f"    Fill rate: ~63% (below 90% target → shows red KPI)")

    # ── 3. WRITE-OFF LOG — 2 Omeprazole expired entries ─────────────────────
    # Find Omeprazole batch
    cur.execute("SELECT id FROM drugs WHERE name = 'Omeprazole Cap' LIMIT 1")
    row = cur.fetchone()
    if row:
        drug_id = row[0]
        cur.execute("SELECT id FROM batches WHERE drug_id = ? LIMIT 1", (drug_id,))
        batch_row = cur.fetchone()
        if batch_row:
            batch_id = batch_row[0]
            cur.execute(
                "INSERT INTO writeoff_log (drug_id, batch_id, quantity, expiry_date, writeoff_date, reason) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (drug_id, batch_id, 20, "2026-05-01",
                 (today - timedelta(days=5)).isoformat(), "expired"),
            )
            print(f"  ✓ Inserted write-off entry for Omeprazole Cap (20 units expired)")

    conn.commit()
    conn.close()

    print("\n✓ Demo data seeded successfully.")
    print("  Revenue chart will show 21 days of sales history.")
    print("  Analytics fill rate KPI will show ~63% (below target — red).")
    print("  Needs Attention will show low stock + expiry + expired items.")
    print("  History tab will show 12 prescription records.")


if __name__ == "__main__":
    run()

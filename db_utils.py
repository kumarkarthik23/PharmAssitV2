"""
db_utils.py
===========
Database access layer for PharmAssist V2.

All SQLite reads and writes are centralised here. No SQL appears
anywhere else in the codebase. Every public function returns plain
Python dicts so callers never touch sqlite3.Row objects directly.

Schema
------
drugs               Master drug registry (name, brand, price, alert threshold).
batches             Per-batch stock records with individual expiry dates.
                    Stock is consumed FIFO (oldest expiry first).
sales               Immutable transaction log — one row per batch consumed.
prescription_history Uploaded prescription images with extraction outcomes.
writeoff_log        Audit trail for expired-stock write-offs.

Design notes
------------
- drugs.quantity and drugs.expiry_date are never stored directly;
  they are always computed from the batches table via aggregation.
- deduct_stock() consumes batches in expiry-date ascending order
  (FIFO), splitting across multiple batches when necessary.
- All monetary values are rounded to 2 decimal places before return.
- migrate_db() is safe to call on every startup; it is idempotent.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta
from typing import Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

from pathlib import Path
DB_PATH = str(Path(__file__).parent / "pharmacy.db")

# ---------------------------------------------------------------------------
# Seed constants — 13 drugs from the 3 test prescriptions
# Deliberate stock/expiry variation covers every dashboard scenario
# ---------------------------------------------------------------------------

_SEED_DRUGS: list[tuple] = [
    # (name,               brand,         price, low_stock_threshold)
    ("Augmentin 625mg",   "Augmentin",    1.20,  20),   #  1 — good stock
    ("Enzoflam",          "Enzoflam",     0.85,  15),   #  2 — LOW STOCK
    ("Pan-D 40mg",        "Pan-D",        0.60,  15),   #  3 — expiring ~25d
    ("Hexigel",           "Hexigel",      1.50,  10),   #  4 — OUT OF STOCK
    ("Ultraflex Plus",    "Ultraflex",    1.10,  15),   #  5 — 2 batches (FIFO)
    ("Relentas",          "Relentas",     0.95,  20),   #  6 — LOW STOCK
    ("Ultracal-D",        "Ultracal-D",   0.75,  20),   #  7 — good stock
    ("Cartilix",          "Cartilix",     1.30,  10),   #  8 — good stock
    ("Diclofenac 50mg",   "Diclofenac",   0.45,  25),   #  9 — expiring ~60d
    ("Omeprazole Cap",    "Omeprazole",   0.55,  15),   # 10 — EXPIRED May 2026
    ("Bonphrozy 2mg",     "Bonphrozy",    2.00,  10),   # 11 — good stock
    ("Clonthogan",        "Clemo",        2.00,  10),   # 12 — good stock
    ("Prednisolone",      "Feolho",       0.90,  15),   # 13 — LOW STOCK
]

# Batches: (drug_id, quantity, expiry_date)
# Drug 5 has TWO batches for FIFO testing. Drug 4 (Hexigel) = 0 qty.
_SEED_BATCHES: list[tuple[int, int, str]] = [
    # Quantities calculated to produce realistic remaining stock after 180 days of sales.
    # High-velocity drugs (Augmentin, Ultracal-D, Diclofenac, Bonphrozy, Clonthogan)
    # will show in Restock Suggestions (≤30 days remaining at current velocity).
    # Low-stock drugs (Enzoflam, Relentas, Prednisolone) deplete to alert levels.
    (1, 2018, "2027-08-01"),   # Augmentin 625mg   — depletes to ~10 units → RESTOCK
    (2,   50, "2027-06-01"),   # Enzoflam          — depletes to 6 units → LOW STOCK
    (3,  600, "2026-07-12"),   # Pan-D 40mg        — expiring ~25 days
    (4,    0, "2027-03-01"),   # Hexigel           — OUT OF STOCK
    (5,  480, "2026-12-01"),   # Ultraflex Plus    — batch 1 FIFO (earlier expiry)
    (5,  200, "2027-07-01"),   # Ultraflex Plus    — batch 2 FIFO
    (6,   60, "2027-09-01"),   # Relentas          — depletes to 8 units → LOW STOCK
    (7, 2037, "2027-10-01"),   # Ultracal-D        — depletes to ~25 units → RESTOCK
    (8,  465, "2027-04-01"),   # Cartilix          — good stock remaining
    (9, 1525, "2026-08-17"),   # Diclofenac 50mg   — depletes to ~15 units → RESTOCK
    (10,  340, "2026-05-01"),  # Omeprazole Cap    — EXPIRED (supports sales history)
    (11, 441, "2027-05-01"),   # Bonphrozy 2mg     — depletes to ~50 units → RESTOCK
    (12, 351, "2027-06-01"),   # Clonthogan        — depletes to ~60 units → RESTOCK
    (13,  50, "2027-05-01"),   # Prednisolone      — depletes to 5 units → LOW STOCK
]

# ---------------------------------------------------------------------------
# Demo data constants
# ---------------------------------------------------------------------------

# Sales: (drug_id, qty, days_ago) — 180 days of history with realistic growth
_DEMO_SALES: list[tuple[int, int, int]] = [
    (1,9,180),(2,3,180),(3,6,180),(5,6,180),
    (6,2,180),(7,13,180),(8,5,180),(9,8,180),
    (10,5,180),(11,3,180),(12,2,180),(13,2,180),
    (1,3,179),(3,3,179),(7,7,179),(9,6,179),
    (1,2,178),(3,2,178),(5,2,178),(7,4,178),
    (9,2,178),(1,9,177),(3,6,177),(6,2,177),
    (7,17,177),(9,14,177),(11,6,177),(12,5,177),
    (1,9,176),(2,6,176),(3,6,176),(5,7,176),
    (7,14,176),(8,5,176),(9,13,176),(10,6,176),
    (13,2,176),(1,6,175),(3,6,175),(7,10,175),
    (9,8,175),(1,7,174),(2,3,174),(3,6,174),
    (5,8,174),(6,2,174),(7,11,174),(8,4,174),
    (9,9,174),(10,7,174),(11,5,174),(12,4,174),
    (1,7,173),(3,8,173),(7,10,173),(9,10,173),
    (1,7,172),(2,3,172),(3,4,172),(5,5,172),
    (7,9,172),(8,3,172),(9,5,172),(10,2,172),
    (13,1,172),(1,2,171),(3,1,171),(7,4,171),
    (9,3,171),(1,14,170),(2,6,170),(3,7,170),
    (5,7,170),(7,16,170),(8,5,170),(9,14,170),
    (10,9,170),(1,9,169),(3,6,169),(7,16,169),
    (9,11,169),(1,7,168),(2,3,168),(3,6,168),
    (5,8,168),(6,3,168),(7,12,168),(8,3,168),
    (9,10,168),(10,8,168),(11,5,168),(12,5,168),
    (13,3,168),(1,6,167),(3,8,167),(7,14,167),
    (9,12,167),(1,8,166),(2,5,166),(3,6,166),
    (5,7,166),(7,12,166),(8,6,166),(9,14,166),
    (10,5,166),(1,6,165),(3,3,165),(6,1,165),
    (7,9,165),(9,6,165),(11,3,165),(12,2,165),
    (1,2,164),(3,2,164),(7,4,164),(8,1,164),
    (9,2,164),(1,14,163),(3,8,163),(7,11,163),
    (9,17,163),(1,12,162),(2,4,162),(3,8,162),
    (5,6,162),(6,3,162),(7,15,162),(8,4,162),
    (9,12,162),(10,7,162),(11,4,162),(12,4,162),
    (1,9,161),(3,6,161),(7,14,161),(9,14,161),
    (1,8,160),(2,4,160),(3,10,160),(5,9,160),
    (7,13,160),(8,5,160),(9,9,160),(10,5,160),
    (13,2,160),(1,10,159),(3,6,159),(6,2,159),
    (7,10,159),(9,13,159),(11,4,159),(12,5,159),
    (1,7,158),(2,2,158),(3,4,158),(5,5,158),
    (7,6,158),(8,2,158),(9,9,158),(10,4,158),
    (1,3,157),(3,2,157),(7,4,157),(9,3,157),
    (1,9,156),(2,5,156),(3,9,156),(5,9,156),
    (6,3,156),(7,18,156),(8,8,156),(9,11,156),
    (10,7,156),(11,6,156),(12,6,156),(13,2,156),
    (1,11,155),(3,10,155),(7,17,155),(9,14,155),
    (1,11,154),(3,10,154),(5,13,154),(7,19,154),
    (8,5,154),(9,21,154),(10,11,154),(1,17,153),
    (3,14,153),(6,4,153),(7,14,153),(9,16,153),
    (11,6,153),(12,5,153),(1,10,152),(3,14,152),
    (5,9,152),(7,22,152),(8,7,152),(9,16,152),
    (10,12,152),(13,4,152),(1,6,151),(3,5,151),
    (7,6,151),(9,6,151),(1,4,150),(3,2,150),
    (6,1,150),(7,4,150),(9,3,150),(11,1,150),
    (1,14,149),(3,8,149),(7,13,149),(9,19,149),
    (1,9,148),(3,9,148),(5,8,148),(7,15,148),
    (8,6,148),(9,16,148),(10,6,148),(13,3,148),
    (1,9,147),(3,8,147),(6,3,147),(7,13,147),
    (9,11,147),(11,6,147),(12,3,147),(1,10,146),
    (3,11,146),(5,6,146),(7,12,146),(8,5,146),
    (9,17,146),(10,9,146),(1,13,145),(3,8,145),
    (7,12,145),(9,16,145),(1,7,144),(3,7,144),
    (5,5,144),(6,1,144),(7,10,144),(8,3,144),
    (9,9,144),(10,5,144),(11,2,144),(12,2,144),
    (13,1,144),(1,3,143),(3,2,143),(7,4,143),
    (9,4,143),(1,11,142),(3,9,142),(5,10,142),
    (7,22,142),(8,8,142),(9,12,142),(10,8,142),
    (1,10,141),(3,6,141),(6,3,141),(7,16,141),
    (9,11,141),(11,7,141),(12,4,141),(1,11,140),
    (3,6,140),(5,11,140),(7,19,140),(8,6,140),
    (9,16,140),(10,8,140),(13,2,140),(1,9,139),
    (3,8,139),(7,19,139),(9,16,139),(1,14,138),
    (3,7,138),(5,8,138),(6,2,138),(7,18,138),
    (8,7,138),(9,13,138),(10,8,138),(11,4,138),
    (12,5,138),(1,8,137),(3,7,137),(7,11,137),
    (9,10,137),(1,2,136),(3,2,136),(7,5,136),
    (9,5,136),(10,2,136),(13,1,136),(1,17,135),
    (3,9,135),(6,4,135),(7,18,135),(9,15,135),
    (11,9,135),(12,4,135),(1,8,134),(3,8,134),
    (5,11,134),(7,20,134),(8,5,134),(9,15,134),
    (10,7,134),(1,15,133),(3,9,133),(7,20,133),
    (9,11,133),(1,15,132),(3,12,132),(5,8,132),
    (6,2,132),(7,15,132),(8,7,132),(9,13,132),
    (10,8,132),(11,6,132),(12,4,132),(13,3,132),
    (1,10,131),(3,11,131),(7,11,131),(9,18,131),
    (1,7,130),(3,6,130),(5,6,130),(7,9,130),
    (8,2,130),(9,9,130),(10,4,130),(1,3,129),
    (3,3,129),(7,4,129),(9,3,129),(1,13,128),
    (3,11,128),(5,15,128),(7,22,128),(8,9,128),
    (9,19,128),(10,8,128),(13,4,128),(1,8,127),
    (3,8,127),(7,16,127),(9,15,127),(1,13,126),
    (3,9,126),(5,8,126),(6,3,126),(7,20,126),
    (8,7,126),(9,12,126),(10,6,126),(11,6,126),
    (12,5,126),(1,11,125),(3,12,125),(7,19,125),
    (9,16,125),(1,13,124),(3,9,124),(5,11,124),
    (7,21,124),(8,10,124),(9,14,124),(10,10,124),
    (13,4,124),(1,8,123),(3,8,123),(6,2,123),
    (7,11,123),(9,13,123),(11,3,123),(12,4,123),
    (1,5,122),(3,3,122),(7,6,122),(8,2,122),
    (9,7,122),(1,23,121),(3,17,121),(7,34,121),
    (9,25,121),(1,16,120),(3,11,120),(5,11,120),
    (6,3,120),(7,20,120),(8,7,120),(9,19,120),
    (10,9,120),(11,6,120),(12,4,120),(13,2,120),
    (1,14,119),(3,12,119),(7,17,119),(9,16,119),
    (1,11,118),(3,9,118),(5,9,118),(7,15,118),
    (8,7,118),(9,12,118),(10,7,118),(1,14,117),
    (3,11,117),(6,2,117),(7,16,117),(9,16,117),
    (11,6,117),(12,4,117),(1,7,116),(3,6,116),
    (5,7,116),(7,12,116),(8,4,116),(9,8,116),
    (10,3,116),(13,1,116),(1,4,115),(3,3,115),
    (7,6,115),(9,4,115),(1,18,114),(3,13,114),
    (5,10,114),(6,3,114),(7,20,114),(8,6,114),
    (9,17,114),(10,11,114),(11,8,114),(12,5,114),
    (1,13,113),(3,8,113),(7,19,113),(9,11,113),
    (1,12,112),(5,7,112),(7,19,112),(8,5,112),
    (9,15,112),(10,6,112),(13,3,112),(1,11,111),
    (6,1,111),(7,20,111),(9,15,111),(11,8,111),
    (12,6,111),(1,11,110),(5,7,110),(7,18,110),
    (8,9,110),(9,14,110),(10,9,110),(1,9,109),
    (7,11,109),(9,11,109),(1,5,108),(5,2,108),
    (7,5,108),(8,2,108),(9,5,108),(10,2,108),
    (12,1,108),(1,12,107),(7,15,107),(9,17,107),
    (1,15,106),(5,10,106),(7,20,106),(8,5,106),
    (9,18,106),(10,9,106),(1,10,105),(7,22,105),
    (9,17,105),(11,5,105),(12,7,105),(1,16,104),
    (5,10,104),(7,17,104),(8,7,104),(9,15,104),
    (10,11,104),(13,4,104),(1,10,103),(7,24,103),
    (9,18,103),(1,10,102),(5,6,102),(7,14,102),
    (8,3,102),(9,12,102),(10,5,102),(11,4,102),
    (12,3,102),(1,4,101),(7,4,101),(9,6,101),
    (1,20,100),(5,16,100),(7,19,100),(8,8,100),
    (9,22,100),(10,10,100),(13,1,100),(1,17,99),
    (7,15,99),(9,20,99),(11,6,99),(12,7,99),
    (1,16,98),(5,8,98),(7,24,98),(8,5,98),
    (9,19,98),(10,9,98),(1,16,97),(7,21,97),
    (9,18,97),(1,18,96),(5,11,96),(7,28,96),
    (8,8,96),(9,23,96),(10,12,96),(11,10,96),
    (12,7,96),(1,10,95),(7,17,95),(9,11,95),
    (1,4,94),(5,4,94),(7,8,94),(8,2,94),
    (9,6,94),(1,29,93),(7,26,93),(9,21,93),
    (11,10,93),(12,7,93),(1,12,92),(5,12,92),
    (7,17,92),(8,10,92),(9,18,92),(10,11,92),
    (1,18,91),(7,19,91),(9,21,91),(1,15,90),
    (5,11,90),(7,14,90),(8,10,90),(9,17,90),
    (10,9,90),(11,7,90),(12,4,90),(1,16,89),
    (7,14,89),(9,14,89),(1,9,88),(5,9,88),
    (7,9,88),(8,5,88),(9,11,88),(1,3,87),
    (7,5,87),(9,5,87),(1,16,86),(5,15,86),
    (7,27,86),(8,12,86),(9,18,86),(1,12,85),
    (7,22,85),(9,14,85),(1,12,84),(5,8,84),
    (7,21,84),(8,7,84),(9,15,84),(11,9,84),
    (12,6,84),(1,17,83),(7,25,83),(9,21,83),
    (1,16,82),(5,15,82),(7,19,82),(8,8,82),
    (9,20,82),(1,11,81),(7,9,81),(9,8,81),
    (11,4,81),(12,4,81),(1,4,80),(7,7,80),
    (9,5,80),(1,14,79),(7,18,79),(9,21,79),
    (1,14,78),(5,4,78),(7,25,78),(8,8,78),
    (9,24,78),(11,10,78),(12,6,78),(1,13,77),
    (7,15,77),(9,21,77),(1,15,76),(7,26,76),
    (8,6,76),(9,20,76),(1,15,75),(7,19,75),
    (9,17,75),(11,9,75),(12,7,75),(1,8,74),
    (7,11,74),(8,6,74),(9,13,74),(1,4,73),
    (7,6,73),(9,5,73),(1,17,72),(7,26,72),
    (8,13,72),(9,25,72),(11,10,72),(12,7,72),
    (1,14,71),(7,25,71),(9,20,71),(1,18,70),
    (7,22,70),(8,10,70),(9,18,70),(1,18,69),
    (7,28,69),(9,20,69),(11,7,69),(12,5,69),
    (1,16,68),(7,16,68),(8,11,68),(9,12,68),
    (1,7,67),(7,15,67),(1,4,66),(7,5,66),
    (12,2,66),(1,24,65),(7,43,65),(1,21,64),
    (7,35,64),(8,10,64),(1,20,63),(7,29,63),
    (11,13,63),(12,7,63),(1,19,62),(7,37,62),
    (8,11,62),(1,13,61),(7,23,61),(1,9,60),
    (7,13,60),(8,4,60),(11,4,60),(12,4,60),
    (1,4,59),(7,7,59),(1,14,58),(7,30,58),
    (8,13,58),(1,16,57),(7,27,57),(11,11,57),
    (12,6,57),(1,12,56),(7,24,56),(8,11,56),
    (1,16,55),(7,5,55),(1,16,54),(8,10,54),
    (11,7,54),(12,6,54),(1,13,53),(1,4,52),
    (1,25,51),(11,10,51),(12,7,51),(1,19,50),
    (8,11,50),(1,12,49),(1,13,48),(8,6,48),
    (11,10,48),(12,6,48),(1,19,47),(1,13,46),
    (1,6,45),(11,3,45),(12,1,45),(1,17,44),
    (1,21,43),(1,14,42),(11,10,42),(12,6,42),
    (1,22,41),(1,14,40),(1,9,39),(11,6,39),
    (12,5,39),(1,6,38),(1,20,37),(1,19,36),
    (11,8,36),(12,8,36),(1,22,35),(1,24,34),
    (1,25,33),(11,16,33),(12,8,33),(1,18,32),
    (1,5,31),(1,25,30),(11,12,30),(12,9,30),
    (1,23,29),(1,16,28),(1,17,27),(11,10,27),
    (12,8,27),(1,21,26),(1,13,25),(1,6,24),
    (1,26,23),(1,14,22),(1,22,21),(11,8,21),
    (12,8,21),(1,25,20),(1,15,19),(11,6,18),
    (12,5,18),(11,13,15),(12,6,15),(11,13,12),
    (12,10,12),(11,9,9),(12,10,9),(11,13,6),
    (12,10,6),(1,8,0),(3,6,0),(7,12,0),
    (9,10,0),(8,5,0),(11,4,0),
]

# Prescriptions: (days_ago, outcome, medicines)
# 28 sold, 6 partial, 5 cancelled, 2 abandoned, 2 pending
# Fill rate = 28/(28+6+5) = 71.8% → amber KPI (realistic, below 90% target)
# 2 pending today → nav badge shows
_DEMO_PRESCRIPTIONS: list[tuple] = [
    # --- Dec 2025 (6 months ago) ---
    (175,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5},
      {"drug_name":"Enzoflam","frequency":2,"duration":5,"required_quantity":10}]),
    (168,"sold",
     [{"drug_name":"Ultraflex Plus","frequency":3,"duration":10,"required_quantity":30},
      {"drug_name":"Relentas","frequency":2,"duration":10,"required_quantity":20},
      {"drug_name":"Ultracal-D","frequency":1,"duration":10,"required_quantity":10}]),
    (162,"cancelled",
     [{"drug_name":"Cartilix","frequency":2,"duration":30,"required_quantity":60},
      {"drug_name":"Bonphrozy 2mg","frequency":1,"duration":30,"required_quantity":30}]),
    (155,"sold",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Omeprazole Cap","frequency":1,"duration":5,"required_quantity":5}]),
    # --- Jan 2026 (5 months ago) ---
    (148,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Enzoflam","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":7,"required_quantity":7},
      {"drug_name":"Hexigel","frequency":2,"duration":7,"required_quantity":14}]),
    (141,"partial",
     [{"drug_name":"Ultraflex Plus","frequency":2,"duration":30,"required_quantity":60},
      {"drug_name":"Relentas","frequency":1,"duration":30,"required_quantity":30},
      {"drug_name":"Cartilix","frequency":2,"duration":30,"required_quantity":60}]),
    (135,"sold",
     [{"drug_name":"Clonthogan","frequency":1,"duration":14,"required_quantity":14},
      {"drug_name":"Prednisolone","frequency":2,"duration":5,"required_quantity":10}]),
    (128,"sold",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Ultracal-D","frequency":1,"duration":14,"required_quantity":14},
      {"drug_name":"Omeprazole Cap","frequency":1,"duration":7,"required_quantity":7}]),
    (122,"cancelled",
     [{"drug_name":"Bonphrozy 2mg","frequency":1,"duration":30,"required_quantity":30},
      {"drug_name":"Ultracal-D","frequency":1,"duration":30,"required_quantity":30}]),
    # --- Feb 2026 (4 months ago) ---
    (115,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5}]),
    (108,"sold",
     [{"drug_name":"Ultraflex Plus","frequency":3,"duration":14,"required_quantity":42},
      {"drug_name":"Relentas","frequency":2,"duration":14,"required_quantity":28},
      {"drug_name":"Ultracal-D","frequency":1,"duration":14,"required_quantity":14},
      {"drug_name":"Cartilix","frequency":1,"duration":14,"required_quantity":14}]),
    (101,"partial",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":10,"required_quantity":20},
      {"drug_name":"Omeprazole Cap","frequency":1,"duration":10,"required_quantity":10},
      {"drug_name":"Enzoflam","frequency":2,"duration":5,"required_quantity":10}]),
    (95,"sold",
     [{"drug_name":"Clonthogan","frequency":1,"duration":7,"required_quantity":7},
      {"drug_name":"Prednisolone","frequency":1,"duration":7,"required_quantity":7},
      {"drug_name":"Bonphrozy 2mg","frequency":1,"duration":14,"required_quantity":14}]),
    (88,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5},
      {"drug_name":"Enzoflam","frequency":2,"duration":5,"required_quantity":10}]),
    # --- Mar 2026 (3 months ago) ---
    (81,"sold",
     [{"drug_name":"Ultracal-D","frequency":2,"duration":30,"required_quantity":60},
      {"drug_name":"Cartilix","frequency":1,"duration":30,"required_quantity":30},
      {"drug_name":"Bonphrozy 2mg","frequency":1,"duration":30,"required_quantity":30}]),
    (74,"partial",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Hexigel","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":7,"required_quantity":7}]),
    (68,"sold",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Ultracal-D","frequency":1,"duration":5,"required_quantity":5}]),
    (61,"cancelled",
     [{"drug_name":"Relentas","frequency":2,"duration":30,"required_quantity":60},
      {"drug_name":"Cartilix","frequency":2,"duration":30,"required_quantity":60}]),
    (55,"sold",
     [{"drug_name":"Clonthogan","frequency":1,"duration":14,"required_quantity":14},
      {"drug_name":"Prednisolone","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Augmentin 625mg","frequency":2,"duration":7,"required_quantity":14}]),
    # --- Apr 2026 (2 months ago) ---
    (48,"sold",
     [{"drug_name":"Ultraflex Plus","frequency":2,"duration":30,"required_quantity":60},
      {"drug_name":"Ultracal-D","frequency":1,"duration":30,"required_quantity":30},
      {"drug_name":"Bonphrozy 2mg","frequency":1,"duration":30,"required_quantity":30}]),
    (41,"partial",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Enzoflam","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Hexigel","frequency":2,"duration":5,"required_quantity":10}]),
    (35,"sold",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Cartilix","frequency":1,"duration":14,"required_quantity":14},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":7,"required_quantity":7}]),
    (28,"sold",
     [{"drug_name":"Clonthogan","frequency":1,"duration":7,"required_quantity":7},
      {"drug_name":"Bonphrozy 2mg","frequency":1,"duration":14,"required_quantity":14}]),
    (21,"cancelled",
     [{"drug_name":"Ultracal-D","frequency":2,"duration":60,"required_quantity":120},
      {"drug_name":"Cartilix","frequency":2,"duration":60,"required_quantity":120}]),
    # --- May-Jun 2026 (last 3 weeks) ---
    (20,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5},
      {"drug_name":"Enzoflam","frequency":2,"duration":5,"required_quantity":10}]),
    (18,"sold",
     [{"drug_name":"Ultraflex Plus","frequency":3,"duration":10,"required_quantity":30},
      {"drug_name":"Relentas","frequency":2,"duration":10,"required_quantity":20},
      {"drug_name":"Ultracal-D","frequency":1,"duration":10,"required_quantity":10}]),
    (15,"sold",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Cartilix","frequency":1,"duration":10,"required_quantity":10}]),
    (13,"partial",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Hexigel","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5}]),
    (11,"sold",
     [{"drug_name":"Clonthogan","frequency":1,"duration":14,"required_quantity":14},
      {"drug_name":"Prednisolone","frequency":2,"duration":5,"required_quantity":10}]),
    (9,"sold",
     [{"drug_name":"Bonphrozy 2mg","frequency":1,"duration":30,"required_quantity":30},
      {"drug_name":"Ultracal-D","frequency":2,"duration":30,"required_quantity":60}]),
    (7,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5}]),
    (5,"partial",
     [{"drug_name":"Relentas","frequency":2,"duration":10,"required_quantity":20},
      {"drug_name":"Ultracal-D","frequency":1,"duration":10,"required_quantity":10},
      {"drug_name":"Hexigel","frequency":2,"duration":5,"required_quantity":10}]),
    (4,"sold",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Cartilix","frequency":1,"duration":14,"required_quantity":14}]),
    (3,"cancelled",
     [{"drug_name":"Bonphrozy 2mg","frequency":1,"duration":30,"required_quantity":30}]),
    (2,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5},
      {"drug_name":"Enzoflam","frequency":2,"duration":5,"required_quantity":10}]),
    # Additional sold prescriptions (boosts fill rate to ~72% amber)
    (45,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Clonthogan","frequency":1,"duration":7,"required_quantity":7}]),
    (33,"sold",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5}]),
    (19,"sold",
     [{"drug_name":"Ultracal-D","frequency":1,"duration":14,"required_quantity":14},
      {"drug_name":"Cartilix","frequency":1,"duration":14,"required_quantity":14},
      {"drug_name":"Bonphrozy 2mg","frequency":1,"duration":14,"required_quantity":14}]),
    (6,"sold",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Enzoflam","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":7,"required_quantity":7}]),
    # Abandoned (>24hrs ago — auto-marked on startup)
    (2,"abandoned",
     [{"drug_name":"Clonthogan","frequency":1,"duration":7,"required_quantity":7},
      {"drug_name":"Prednisolone","frequency":1,"duration":7,"required_quantity":7}]),
    (1,"abandoned",
     [{"drug_name":"Ultraflex Plus","frequency":2,"duration":14,"required_quantity":28},
      {"drug_name":"Bonphrozy 2mg","frequency":1,"duration":14,"required_quantity":14}]),
    # Pending today — shows in nav badge + Today's Prescriptions KPI
    (0,"pending",
     [{"drug_name":"Augmentin 625mg","frequency":2,"duration":5,"required_quantity":10},
      {"drug_name":"Pan-D 40mg","frequency":1,"duration":5,"required_quantity":5}]),
    (0,"pending",
     [{"drug_name":"Diclofenac 50mg","frequency":2,"duration":7,"required_quantity":14},
      {"drug_name":"Ultracal-D","frequency":1,"duration":7,"required_quantity":7}]),
]

# Write-offs: (drug_id, expiry_date, qty, days_ago)
# 4 entries across 4 months — populates expiry loss chart in Analytics
_DEMO_WRITEOFFS: list[tuple] = [
    (3,  "2026-01-15",  8, 155),   # Pan-D 40mg old batch — Jan 2026
    (10, "2026-02-28", 15, 108),   # Omeprazole Cap — Feb 2026
    (9,  "2026-03-31", 25,  78),   # Diclofenac 50mg — Mar 2026
    (10, "2026-05-01", 20,   5),   # Omeprazole Cap — May 2026 (current expired batch)
]

# SQL for performance indexes
_INDEXES: list[str] = [
    "CREATE INDEX IF NOT EXISTS idx_drugs_name      ON drugs(name)",
    "CREATE INDEX IF NOT EXISTS idx_batches_drug    ON batches(drug_id)",
    "CREATE INDEX IF NOT EXISTS idx_batches_expiry  ON batches(expiry_date)",
    "CREATE INDEX IF NOT EXISTS idx_batches_qty     ON batches(quantity)",
    "CREATE INDEX IF NOT EXISTS idx_sales_drug_id   ON sales(drug_id)",
    "CREATE INDEX IF NOT EXISTS idx_sales_date      ON sales(sale_date)",
    "CREATE INDEX IF NOT EXISTS idx_writeoff_drug   ON writeoff_log(drug_id)",
]

# Shared FIFO batch ordering expression used in multiple queries
_FIFO_ORDER = """
    ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
             expiry_date ASC,
             id ASC
"""

# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------

def get_connection() -> sqlite3.Connection:
    """
    Return a SQLite connection with Row factory and foreign-key enforcement.

    Foreign keys are disabled by default in SQLite; enabling them here
    ensures referential integrity is enforced at the database level.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ---------------------------------------------------------------------------
# Schema management
# ---------------------------------------------------------------------------

def init_db() -> None:
    """
    Create all tables, indexes, and seed data on first run.

    Safe to call on every application startup — all DDL statements use
    IF NOT EXISTS guards so subsequent calls are no-ops. Calls
    migrate_db() at the end to apply any pending column additions.
    """
    conn = get_connection()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS drugs (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            name                TEXT    NOT NULL,
            brand               TEXT,
            price_per_unit      REAL    NOT NULL DEFAULT 0.0,
            low_stock_threshold INTEGER NOT NULL DEFAULT 20
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS batches (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            drug_id       INTEGER NOT NULL,
            quantity      INTEGER NOT NULL DEFAULT 0,
            expiry_date   TEXT,
            received_date TEXT    NOT NULL,
            batch_note    TEXT,
            supplier      TEXT,
            FOREIGN KEY (drug_id) REFERENCES drugs(id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sales (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            drug_id       INTEGER NOT NULL,
            batch_id      INTEGER,
            quantity_sold INTEGER NOT NULL,
            sale_date     TEXT    NOT NULL,
            FOREIGN KEY (drug_id)  REFERENCES drugs(id),
            FOREIGN KEY (batch_id) REFERENCES batches(id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS prescription_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            upload_date TEXT NOT NULL,
            image_data  BLOB,
            extracted   TEXT NOT NULL,
            outcome     TEXT NOT NULL DEFAULT 'pending',
            notes       TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS writeoff_log (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            drug_id       INTEGER NOT NULL,
            batch_id      INTEGER NOT NULL,
            quantity      INTEGER NOT NULL,
            expiry_date   TEXT,
            writeoff_date TEXT    NOT NULL,
            reason        TEXT    NOT NULL DEFAULT 'expired',
            FOREIGN KEY (drug_id)  REFERENCES drugs(id),
            FOREIGN KEY (batch_id) REFERENCES batches(id)
        )
    """)

    for statement in _INDEXES:
        cur.execute(statement)

    conn.commit()
    conn.close()
    migrate_db()

    # Seed demo data on first run only
    conn2 = get_connection()
    cur2  = conn2.cursor()
    cur2.execute("SELECT COUNT(*) FROM drugs")
    is_empty = cur2.fetchone()[0] == 0
    conn2.close()
    if is_empty:
        seed_demo_data()


def migrate_db() -> None:
    """
    Apply incremental schema changes to an existing database without
    dropping data. Safe to call on every startup — each alteration is
    guarded by a PRAGMA column existence check.
    """
    conn = get_connection()
    cur  = conn.cursor()

    cur.execute("PRAGMA table_info(drugs)")
    drug_columns = {row[1] for row in cur.fetchall()}
    if "low_stock_threshold" not in drug_columns:
        cur.execute(
            "ALTER TABLE drugs ADD COLUMN "
            "low_stock_threshold INTEGER NOT NULL DEFAULT 20"
        )

    cur.execute("PRAGMA table_info(batches)")
    batch_columns = {row[1] for row in cur.fetchall()}
    if "supplier" not in batch_columns:
        cur.execute("ALTER TABLE batches ADD COLUMN supplier TEXT")

    # Ensure writeoff_log exists for databases created before it was added
    cur.execute("""
        CREATE TABLE IF NOT EXISTS writeoff_log (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            drug_id       INTEGER NOT NULL,
            batch_id      INTEGER NOT NULL,
            quantity      INTEGER NOT NULL,
            expiry_date   TEXT,
            writeoff_date TEXT    NOT NULL,
            reason        TEXT    NOT NULL DEFAULT 'expired',
            FOREIGN KEY (drug_id)  REFERENCES drugs(id),
            FOREIGN KEY (batch_id) REFERENCES batches(id)
        )
    """)

    conn.commit()
    conn.close()


def _wipe_all(conn) -> None:
    """Delete all rows and reset auto-increment counters."""
    for table in ("writeoff_log", "prescription_history", "sales", "batches", "drugs"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute(
        "DELETE FROM sqlite_sequence WHERE name IN "
        "('drugs','batches','sales','prescription_history','writeoff_log')"
    )
    conn.commit()


def reset_db() -> None:
    """Wipe all data then reseed with demo dataset."""
    conn = get_connection()
    _wipe_all(conn)
    conn.close()
    seed_demo_data()


def clear_all_data() -> None:
    """Wipe all data completely — no reseed. For production use."""
    conn = get_connection()
    _wipe_all(conn)
    conn.close()


def seed_demo_data() -> None:
    """
    Populate the database with a realistic demo dataset.

    Called on first run and when resetting to demo mode.
    Inserts 13 drugs, 14 batches, ~70 sales across 21 days,
    12 prescription records, and 1 write-off entry.
    """
    import json as _json
    from collections import defaultdict

    conn = get_connection()
    cur  = conn.cursor()
    today = date.today()

    # Drugs
    cur.executemany(
        "INSERT INTO drugs (name, brand, price_per_unit, low_stock_threshold) "
        "VALUES (?, ?, ?, ?)",
        _SEED_DRUGS,
    )

    # Batches
    cur.executemany(
        "INSERT INTO batches (drug_id, quantity, expiry_date, received_date) "
        "VALUES (?, ?, ?, ?)",
        [(drug_id, qty, expiry, today.isoformat()) for drug_id, qty, expiry in _SEED_BATCHES],
    )

    # Build drug_id → [batch_id, ...] map
    cur.execute("SELECT id, drug_id FROM batches ORDER BY id")
    drug_batches: dict[int, list[int]] = defaultdict(list)
    for b_id, d_id in cur.fetchall():
        drug_batches[d_id].append(b_id)

    # Track remaining batch quantities
    cur.execute("SELECT id, quantity FROM batches")
    batch_qty: dict[int, int] = {b_id: qty for b_id, qty in cur.fetchall()}

    # Sales
    for drug_id, qty_to_sell, days_ago in _DEMO_SALES:
        sale_date = (today - timedelta(days=days_ago)).isoformat()
        remaining = qty_to_sell
        for b_id in drug_batches.get(drug_id, []):
            if remaining <= 0:
                break
            available = batch_qty.get(b_id, 0)
            if available <= 0:
                continue
            take = min(remaining, available)
            cur.execute(
                "INSERT INTO sales (drug_id, batch_id, quantity_sold, sale_date) "
                "VALUES (?, ?, ?, ?)",
                (drug_id, b_id, take, sale_date),
            )
            batch_qty[b_id] -= take
            remaining       -= take

    # Update batch quantities
    for b_id, qty in batch_qty.items():
        cur.execute("UPDATE batches SET quantity = ? WHERE id = ?", (qty, b_id))

    # Prescription history
    for days_ago, outcome, medicines in _DEMO_PRESCRIPTIONS:
        rx_date = (today - timedelta(days=days_ago)).isoformat()
        cur.execute(
            "INSERT INTO prescription_history "
            "(upload_date, image_data, extracted, outcome, notes) "
            "VALUES (?, ?, ?, ?, ?)",
            (rx_date, b"", _json.dumps(medicines), outcome, "demo"),
        )

    # Write-offs
    for drug_id, expiry_date, qty, days_ago in _DEMO_WRITEOFFS:
        writeoff_date = (today - timedelta(days=days_ago)).isoformat()
        batches = drug_batches.get(drug_id, [])
        if batches:
            cur.execute(
                "INSERT INTO writeoff_log "
                "(drug_id, batch_id, quantity, expiry_date, writeoff_date, reason) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (drug_id, batches[0], qty, expiry_date, writeoff_date, "expired"),
            )

    conn.commit()
    conn.close()


def get_data_counts() -> dict:
    """Return current row counts for each resettable category."""
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM drugs");                drugs     = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM batches");              batches   = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM sales");                sales     = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM prescription_history"); prx       = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM writeoff_log");         writeoffs = cur.fetchone()[0]
    conn.close()
    return {"drugs": drugs, "batches": batches, "sales": sales,
            "prescriptions": prx, "writeoffs": writeoffs}


def selective_reset(
    clear_sales:         bool = False,
    clear_prescriptions: bool = False,
    clear_inventory:     bool = False,
    clear_writeoffs:     bool = False,
    mode:                str  = "demo",
) -> dict:
    """Selectively clear data categories. mode='demo' reseeds after clearing inventory."""
    conn    = get_connection()
    summary = {}
    if clear_inventory:
        conn.execute("DELETE FROM writeoff_log")
        conn.execute("DELETE FROM sales")
        conn.execute("DELETE FROM batches")
        conn.execute("DELETE FROM drugs")
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN "
                     "('drugs','batches','sales','writeoff_log')")
        summary["inventory"] = "cleared"
        summary["sales"]     = "cleared (cascade)"
        summary["writeoffs"] = "cleared (cascade)"
    else:
        if clear_sales:
            conn.execute("DELETE FROM sales")
            conn.execute("DELETE FROM sqlite_sequence WHERE name='sales'")
            summary["sales"] = "cleared"
        if clear_writeoffs:
            conn.execute("DELETE FROM writeoff_log")
            conn.execute("DELETE FROM sqlite_sequence WHERE name='writeoff_log'")
            summary["writeoffs"] = "cleared"
    if clear_prescriptions:
        conn.execute("DELETE FROM prescription_history")
        conn.execute("DELETE FROM sqlite_sequence WHERE name='prescription_history'")
        summary["prescriptions"] = "cleared"
    conn.commit()
    conn.close()
    if clear_inventory and mode == "demo":
        seed_demo_data()
        summary["reseeded"] = "demo data inserted"
    return summary


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _round_drug(row: sqlite3.Row) -> dict:
    """Convert a drug Row to a dict, rounding monetary values."""
    d = dict(row)
    d["price_per_unit"] = round(d.get("price_per_unit") or 0.0, 2)
    return d


# ---------------------------------------------------------------------------
# Drug queries
# ---------------------------------------------------------------------------

def get_all_drugs() -> list[dict]:
    """
    Return all drugs ordered alphabetically.

    Each dict is enriched with three computed fields derived from the
    batches table:
      quantity    — total units across all batches
      expiry_date — earliest expiry among non-empty batches
      batch_count — total number of batches (including depleted ones)
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.id,
               d.name,
               d.brand,
               d.price_per_unit,
               d.low_stock_threshold,
               COALESCE(SUM(b.quantity), 0)                       AS quantity,
               MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS expiry_date,
               COUNT(b.id)                                         AS batch_count
        FROM   drugs d
        LEFT   JOIN batches b ON b.drug_id = d.id
        GROUP  BY d.id
        ORDER  BY d.name
    """)
    rows = cur.fetchall()
    conn.close()
    return [_round_drug(r) for r in rows]


def get_drug_by_id(drug_id: int) -> Optional[dict]:
    """
    Look up a single drug by primary key, enriched with batch aggregates.

    Returns None if the drug does not exist.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.id,
               d.name,
               d.brand,
               d.price_per_unit,
               d.low_stock_threshold,
               COALESCE(SUM(b.quantity), 0)                       AS quantity,
               MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS expiry_date,
               COUNT(b.id)                                         AS batch_count
        FROM   drugs d
        LEFT   JOIN batches b ON b.drug_id = d.id
        WHERE  d.id = ?
        GROUP  BY d.id
    """, (drug_id,))
    row = cur.fetchone()
    conn.close()
    return _round_drug(row) if row else None


def get_drug_by_name(name: str) -> Optional[dict]:
    """
    Case-insensitive exact name lookup enriched with batch aggregates.

    Returns None if no drug matches.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.id,
               d.name,
               d.brand,
               d.price_per_unit,
               d.low_stock_threshold,
               COALESCE(SUM(b.quantity), 0)                       AS quantity,
               MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS expiry_date
        FROM   drugs d
        LEFT   JOIN batches b ON b.drug_id = d.id
        WHERE  LOWER(d.name) = LOWER(?)
        GROUP  BY d.id
    """, (name,))
    row = cur.fetchone()
    conn.close()
    return _round_drug(row) if row else None


def find_drug_fuzzy(name: str, threshold: int = 80) -> Optional[dict]:
    """
    Fuzzy name lookup using rapidfuzz token_sort_ratio.

    Attempts an exact match first for performance. Falls back to fuzzy
    matching only when the exact lookup fails. The returned dict includes
    two extra metadata keys when a fuzzy match is found:
      _fuzzy_score   — similarity score (0–100)
      _fuzzy_matched — the name as stored in the database

    Args:
        name:      Drug name to search for (may contain misspellings).
        threshold: Minimum similarity score. 80 catches common typos
                   while avoiding false positives.

    Returns:
        Matching drug dict or None if no match meets the threshold.
    """
    from rapidfuzz import fuzz, process

    all_drugs = get_all_drugs()
    if not all_drugs:
        return None

    # Fast path — exact case-insensitive match
    for drug in all_drugs:
        if drug["name"].lower() == name.lower():
            return drug

    # Fuzzy path
    drug_names = [d["name"] for d in all_drugs]
    result = process.extractOne(
        name,
        drug_names,
        scorer=fuzz.token_sort_ratio,
        score_cutoff=threshold,
    )
    if result:
        matched_name, score, _ = result
        drug = next(d for d in all_drugs if d["name"] == matched_name)
        drug["_fuzzy_score"]   = score
        drug["_fuzzy_matched"] = matched_name
        return drug

    return None


def check_availability(name: str, required_qty: int) -> dict:
    """
    Determine whether a drug is in stock in sufficient quantity.

    Tries exact lookup first, then falls back to fuzzy matching. The
    returned dict provides all information needed to populate the
    availability table in the UI.

    Returns:
        {
            found        (bool)      — drug exists in inventory
            drug         (dict|None) — drug record if found
            sufficient   (bool)      — stock >= required_qty
            fuzzy_match  (bool)      — True when matched via fuzzy search
            matched_name (str)       — name as stored (may differ from input)
        }
    """
    drug        = get_drug_by_name(name)
    fuzzy_match = False

    if drug is None:
        drug = find_drug_fuzzy(name, threshold=80)
        if drug is not None:
            fuzzy_match = True

    if drug is None:
        return {
            "found":        False,
            "drug":         None,
            "sufficient":   False,
            "fuzzy_match":  False,
            "matched_name": name,
        }

    return {
        "found":        True,
        "drug":         drug,
        "sufficient":   drug["quantity"] >= required_qty,
        "fuzzy_match":  fuzzy_match,
        "matched_name": drug.get("_fuzzy_matched", drug["name"]),
    }


# ---------------------------------------------------------------------------
# Batch queries
# ---------------------------------------------------------------------------

def get_batches_for_drug(drug_id: int) -> list[dict]:
    """
    Return all batches for a drug in FIFO order (oldest expiry first).

    Batches without an expiry date are sorted last so they are consumed
    only after all dated batches are exhausted.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute(
        f"""
        SELECT id, drug_id, quantity, expiry_date,
               received_date, batch_note, supplier
        FROM   batches
        WHERE  drug_id = ?
        {_FIFO_ORDER}
        """,
        (drug_id,),
    )
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Stock mutations
# ---------------------------------------------------------------------------

def deduct_stock(drug_id: int, quantity_sold: int) -> bool:
    """
    Deduct stock from a drug's batches using FIFO consumption.

    Fetches active batches in expiry-date ascending order and consumes
    them sequentially until the requested quantity is satisfied. Each
    batch consumed produces one sales record.

    The total available check at the start acts as an atomic guard —
    if total stock is insufficient the function returns False without
    modifying any data.

    Args:
        drug_id:       Primary key of the drug to deduct from.
        quantity_sold: Number of units to deduct.

    Returns:
        True if deduction succeeded, False if insufficient stock.
    """
    conn = get_connection()
    cur  = conn.cursor()

    # BEGIN IMMEDIATE acquires a write lock upfront, preventing concurrent
    # pharmacist sessions from both passing the availability check and
    # overdrafting the same batch.
    cur.execute("BEGIN IMMEDIATE")

    cur.execute(
        "SELECT COALESCE(SUM(quantity), 0) FROM batches WHERE drug_id = ?",
        (drug_id,),
    )
    if cur.fetchone()[0] < quantity_sold:
        cur.execute("ROLLBACK")
        conn.close()
        return False

    cur.execute(
        f"""
        SELECT id, quantity FROM batches
        WHERE  drug_id = ? AND quantity > 0
        {_FIFO_ORDER}
        """,
        (drug_id,),
    )
    batches   = cur.fetchall()
    remaining = quantity_sold
    today     = date.today().isoformat()

    for batch_id, batch_qty in batches:
        if remaining <= 0:
            break
        take = min(remaining, batch_qty)
        cur.execute(
            "UPDATE batches SET quantity = quantity - ? WHERE id = ?",
            (take, batch_id),
        )
        cur.execute(
            "INSERT INTO sales (drug_id, batch_id, quantity_sold, sale_date) "
            "VALUES (?, ?, ?, ?)",
            (drug_id, batch_id, take, today),
        )
        remaining -= take

    conn.commit()
    conn.close()
    return True


def restock_drug(
    drug_id:        int,
    quantity_added: int,
    expiry_date:    str = "",
    batch_note:     str = "",
    supplier:       str = "",
) -> bool:
    """
    Add a new stock batch for an existing drug.

    Each call to restock_drug creates one new row in the batches table.
    The new batch will be consumed after all earlier-expiring batches
    when stock is deducted.

    Returns:
        True on success, False if the drug_id does not exist.
    """
    conn = get_connection()
    cur  = conn.cursor()

    cur.execute("SELECT id FROM drugs WHERE id = ?", (drug_id,))
    if cur.fetchone() is None:
        conn.close()
        return False

    cur.execute(
        "INSERT INTO batches "
        "(drug_id, quantity, expiry_date, received_date, batch_note, supplier) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            drug_id,
            quantity_added,
            expiry_date or None,
            date.today().isoformat(),
            batch_note or None,
            supplier   or None,
        ),
    )
    conn.commit()
    conn.close()
    return True


def update_drug(
    drug_id:             int,
    name:                str,
    brand:               str,
    price_per_unit:      float,
    low_stock_threshold: int = 20,
) -> bool:
    """
    Update master drug data (name, brand, price, alert threshold).

    Stock and expiry data live in the batches table and are not
    affected by this function. Use restock_drug() to add stock.

    Returns:
        True if the row was updated, False if drug_id was not found.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute(
        "UPDATE drugs "
        "SET name = ?, brand = ?, price_per_unit = ?, low_stock_threshold = ? "
        "WHERE id = ?",
        (name, brand, price_per_unit, low_stock_threshold, drug_id),
    )
    updated = cur.rowcount
    conn.commit()
    conn.close()
    return updated > 0


def add_new_drug(
    name:                str,
    brand:               str,
    quantity:            int,
    expiry_date:         str,
    price_per_unit:      float,
    low_stock_threshold: int = 20,
) -> dict:
    """
    Insert a new drug into inventory, optionally with an initial batch.

    Performs a case-insensitive duplicate name check before inserting.
    If quantity > 0 an initial batch row is created automatically.

    Returns:
        {"success": True,  "id": int}
        {"success": False, "reason": "duplicate", "existing_id": int}
    """
    conn = get_connection()
    cur  = conn.cursor()

    cur.execute(
        "SELECT id FROM drugs WHERE LOWER(name) = LOWER(?)", (name,)
    )
    existing = cur.fetchone()
    if existing:
        conn.close()
        return {"success": False, "reason": "duplicate", "existing_id": existing[0]}

    cur.execute(
        "INSERT INTO drugs (name, brand, price_per_unit, low_stock_threshold) "
        "VALUES (?, ?, ?, ?)",
        (name, brand, price_per_unit, low_stock_threshold),
    )
    new_id = cur.lastrowid

    if quantity > 0:
        cur.execute(
            "INSERT INTO batches (drug_id, quantity, expiry_date, received_date) "
            "VALUES (?, ?, ?, ?)",
            (new_id, quantity, expiry_date or None, date.today().isoformat()),
        )

    conn.commit()
    conn.close()
    return {"success": True, "id": new_id}


def delete_drug(drug_id: int) -> dict:
    """
    Remove a drug and all its batches from inventory.

    Deletion is blocked if the drug has any associated sales records to
    preserve the integrity of historical transaction data.

    Returns:
        {"success": True}
        {"success": False, "reason": "not_found"}
        {"success": False, "reason": "has_sales"}
    """
    conn = get_connection()
    cur  = conn.cursor()

    cur.execute("SELECT id FROM drugs WHERE id = ?", (drug_id,))
    if cur.fetchone() is None:
        conn.close()
        return {"success": False, "reason": "not_found"}

    cur.execute("SELECT COUNT(*) FROM sales WHERE drug_id = ?", (drug_id,))
    if cur.fetchone()[0] > 0:
        conn.close()
        return {"success": False, "reason": "has_sales"}

    cur.execute("DELETE FROM batches WHERE drug_id = ?", (drug_id,))
    cur.execute("DELETE FROM drugs   WHERE id = ?",      (drug_id,))
    conn.commit()
    conn.close()
    return {"success": True}


def delete_batch(batch_id: int) -> dict:
    """
    Remove a depleted batch record.

    Deletion is blocked if the batch has sales records attached, which
    would be the case for any batch that was partially or fully consumed.
    Only fully depleted batches (quantity = 0) should be deleted.

    Returns:
        {"success": True}
        {"success": False, "reason": "not_found"}
        {"success": False, "reason": "has_sales"}
    """
    conn = get_connection()
    cur  = conn.cursor()

    cur.execute("SELECT id FROM batches WHERE id = ?", (batch_id,))
    if cur.fetchone() is None:
        conn.close()
        return {"success": False, "reason": "not_found"}

    cur.execute("SELECT COUNT(*) FROM sales WHERE batch_id = ?", (batch_id,))
    if cur.fetchone()[0] > 0:
        conn.close()
        return {"success": False, "reason": "has_sales"}

    cur.execute("DELETE FROM batches WHERE id = ?", (batch_id,))
    conn.commit()
    conn.close()
    return {"success": True}


# ---------------------------------------------------------------------------
# Write-off
# ---------------------------------------------------------------------------

def writeoff_expired_batches() -> dict:
    """
    Zero out all batches that have passed their expiry date.

    For each expired batch with remaining stock, the quantity is set to
    zero and a record is written to writeoff_log for audit purposes.

    Returns:
        {
            success     (bool)      — always True
            count       (int)       — number of batches written off
            total_units (int)       — total units removed from stock
            items       (list[dict])— one entry per batch written off
        }
    """
    conn  = get_connection()
    cur   = conn.cursor()
    today = date.today().isoformat()

    cur.execute("""
        SELECT b.id, b.drug_id, b.quantity, b.expiry_date, d.name
        FROM   batches b
        JOIN   drugs d ON d.id = b.drug_id
        WHERE  b.quantity > 0
          AND  b.expiry_date IS NOT NULL
          AND  date(b.expiry_date) < date('now')
    """)
    expired_batches = cur.fetchall()

    if not expired_batches:
        conn.close()
        return {"success": True, "count": 0, "total_units": 0, "items": []}

    items       = []
    total_units = 0

    for batch_id, drug_id, qty, expiry_date, drug_name in expired_batches:
        cur.execute(
            "INSERT INTO writeoff_log "
            "(drug_id, batch_id, quantity, expiry_date, writeoff_date, reason) "
            "VALUES (?, ?, ?, ?, ?, 'expired')",
            (drug_id, batch_id, qty, expiry_date, today),
        )
        cur.execute(
            "UPDATE batches SET quantity = 0 WHERE id = ?", (batch_id,)
        )
        items.append({
            "drug_name":  drug_name,
            "batch_id":   batch_id,
            "quantity":   qty,
            "expiry_date": expiry_date,
        })
        total_units += qty

    conn.commit()
    conn.close()
    return {
        "success":     True,
        "count":       len(items),
        "total_units": total_units,
        "items":       items,
    }


def get_writeoff_log(limit: int = 50) -> list[dict]:
    """Return the write-off audit log, most recent entries first."""
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT w.id, d.name, d.brand, w.quantity,
               w.expiry_date, w.writeoff_date, w.reason
        FROM   writeoff_log w
        JOIN   drugs d ON w.drug_id = d.id
        ORDER  BY w.writeoff_date DESC, w.id DESC
        LIMIT  ?
    """, (limit,))
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Expiry timeline
# ---------------------------------------------------------------------------

def get_expiry_timeline() -> dict:
    """
    Return active batches grouped into four expiry buckets.

    Used by the inventory expiry timeline card to give a pharmacist
    a forward-looking view of upcoming expiries.

    Returns:
        {
            already_expired (list) — batches past expiry date with stock > 0
            within_30_days  (list) — expiring in 0–30 days
            within_60_days  (list) — expiring in 31–60 days
            within_90_days  (list) — expiring in 61–90 days
        }
    """
    conn = get_connection()
    cur  = conn.cursor()

    batch_select = """
        SELECT d.name, d.brand, b.id AS batch_id,
               b.quantity, b.expiry_date, b.supplier
        FROM   batches b
        JOIN   drugs d ON d.id = b.drug_id
        WHERE  b.quantity > 0
          AND  b.expiry_date IS NOT NULL
    """

    cur.execute(
        batch_select + " AND date(b.expiry_date) < date('now') "
        "ORDER BY date(b.expiry_date) ASC"
    )
    already_expired = [dict(r) for r in cur.fetchall()]

    def fetch_bucket(days_from: int, days_to: int) -> list[dict]:
        cur.execute(
            batch_select
            + f" AND date(b.expiry_date) >= date('now', '+{days_from} days')"
            + f" AND date(b.expiry_date) <= date('now', '+{days_to} days')"
            + " ORDER BY date(b.expiry_date) ASC"
        )
        return [dict(r) for r in cur.fetchall()]

    within_30 = fetch_bucket(0,  30)
    within_60 = fetch_bucket(31, 60)
    within_90 = fetch_bucket(61, 90)

    conn.close()
    return {
        "already_expired": already_expired,
        "within_30_days":  within_30,
        "within_60_days":  within_60,
        "within_90_days":  within_90,
    }


# ---------------------------------------------------------------------------
# Alert queries
# ---------------------------------------------------------------------------

def get_expiring_drugs(days_threshold: int = 90) -> list[dict]:
    """
    Return drugs that have at least one active batch expiring within
    the specified number of days. Results are ordered soonest first.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.id, d.name, d.brand, d.price_per_unit, d.low_stock_threshold,
               SUM(b.quantity)    AS quantity,
               MIN(b.expiry_date) AS expiry_date
        FROM   batches b
        JOIN   drugs d ON d.id = b.drug_id
        WHERE  b.quantity > 0
          AND  b.expiry_date IS NOT NULL
          AND  date(b.expiry_date) <= date('now', ? || ' days')
          AND  date(b.expiry_date) >= date('now')
        GROUP  BY d.id
        ORDER  BY date(b.expiry_date) ASC
    """, (f"+{days_threshold}",))
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_expired_drugs() -> list[dict]:
    """
    Return drugs that have at least one batch past its expiry date
    with remaining stock (i.e. stock that should be written off).
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.id, d.name, d.brand, d.price_per_unit, d.low_stock_threshold,
               SUM(b.quantity)    AS quantity,
               MIN(b.expiry_date) AS expiry_date
        FROM   batches b
        JOIN   drugs d ON d.id = b.drug_id
        WHERE  b.quantity > 0
          AND  b.expiry_date IS NOT NULL
          AND  date(b.expiry_date) < date('now')
        GROUP  BY d.id
        ORDER  BY date(b.expiry_date) ASC
    """)
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_low_stock_drugs(threshold: Optional[int] = None) -> list[dict]:
    """
    Return drugs whose total stock is at or below their alert threshold.

    Args:
        threshold: When provided, this value overrides each drug's own
                   low_stock_threshold and applies uniformly. When None
                   (the default), each drug's individual threshold is used.
    """
    conn = get_connection()
    cur  = conn.cursor()

    base = """
        SELECT d.id, d.name, d.brand, d.price_per_unit, d.low_stock_threshold,
               COALESCE(SUM(b.quantity), 0) AS quantity,
               MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS expiry_date
        FROM   drugs d
        LEFT   JOIN batches b ON b.drug_id = d.id
        GROUP  BY d.id
    """

    if threshold is not None:
        cur.execute(base + " HAVING quantity <= ? ORDER BY quantity ASC", (threshold,))
    else:
        cur.execute(base + " HAVING quantity <= d.low_stock_threshold ORDER BY quantity ASC")

    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_out_of_stock_drugs() -> list[dict]:
    """Return drugs with zero total stock across all batches."""
    return get_low_stock_drugs(threshold=0)


# ---------------------------------------------------------------------------
# Sales queries
# ---------------------------------------------------------------------------

def get_sales_log(limit: int = 100) -> list[dict]:
    """
    Return the most recent sales records, newest first.

    Includes the batch expiry date so the UI can show which batch was
    consumed for each transaction.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT s.id,
               d.name,
               d.brand,
               s.quantity_sold,
               s.sale_date,
               ROUND(s.quantity_sold * d.price_per_unit, 2) AS total_price,
               b.expiry_date                                  AS batch_expiry
        FROM   sales s
        JOIN   drugs   d ON s.drug_id  = d.id
        LEFT   JOIN batches b ON s.batch_id = b.id
        ORDER  BY s.sale_date DESC, s.id DESC
        LIMIT  ?
    """, (limit,))
    rows = cur.fetchall()
    conn.close()
    return [
        {**dict(r), "total_price": round(r["total_price"] or 0.0, 2)}
        for r in rows
    ]


def get_sales_summary() -> dict:
    """Return aggregate totals: revenue, units sold, and transaction count."""
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT COUNT(*),
               COALESCE(SUM(s.quantity_sold), 0),
               COALESCE(SUM(s.quantity_sold * d.price_per_unit), 0)
        FROM   sales s
        JOIN   drugs d ON s.drug_id = d.id
    """)
    transactions, units_sold, revenue = cur.fetchone()
    conn.close()
    return {
        "total_transactions": transactions,
        "total_units_sold":   units_sold,
        "total_revenue":      round(revenue, 2),
    }


def get_top_selling_drugs(limit: int = 5) -> list[dict]:
    """Return the top-selling drugs by units sold, descending."""
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.name,
               d.brand,
               SUM(s.quantity_sold)                    AS units_sold,
               SUM(s.quantity_sold * d.price_per_unit) AS revenue
        FROM   sales s
        JOIN   drugs d ON s.drug_id = d.id
        GROUP  BY s.drug_id
        ORDER  BY units_sold DESC
        LIMIT  ?
    """, (limit,))
    rows = cur.fetchall()
    conn.close()
    return [
        {
            "name":       r[0],
            "brand":      r[1],
            "units_sold": r[2],
            "revenue":    round(r[3], 2),
        }
        for r in rows
    ]


def get_sales_by_date() -> list[dict]:
    """
    Return daily sales totals ordered chronologically.
    Used to populate the revenue-over-time line chart.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT s.sale_date,
               SUM(s.quantity_sold)                    AS units_sold,
               SUM(s.quantity_sold * d.price_per_unit) AS revenue
        FROM   sales s
        JOIN   drugs d ON s.drug_id = d.id
        GROUP  BY s.sale_date
        ORDER  BY s.sale_date ASC
    """)
    rows = cur.fetchall()
    conn.close()
    return [
        {"date": r[0], "units_sold": r[1], "revenue": round(r[2], 2)}
        for r in rows
    ]


def get_sales_by_drug() -> list[dict]:
    """
    Return per-drug sales totals ordered by revenue descending.
    Used to populate the sales breakdown table in Analytics.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.name,
               d.brand,
               SUM(s.quantity_sold)                    AS units_sold,
               SUM(s.quantity_sold * d.price_per_unit) AS revenue,
               COUNT(*)                                AS transactions
        FROM   sales s
        JOIN   drugs d ON s.drug_id = d.id
        GROUP  BY s.drug_id
        ORDER  BY revenue DESC
    """)
    rows = cur.fetchall()
    conn.close()
    return [
        {
            "name":         r[0],
            "brand":        r[1],
            "units_sold":   r[2],
            "revenue":      round(r[3], 2),
            "transactions": r[4],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Restock suggestions
# ---------------------------------------------------------------------------

def get_restock_suggestions(
    days_window:        int = 14,
    low_days_threshold: int = 30,
) -> list[dict]:
    """
    Identify drugs at risk of running out based on recent sales velocity.

    Strategy:
        1. Sum units sold per drug over the last days_window days.
        2. Divide by days_window to derive average daily velocity.
        3. Divide current stock by velocity to estimate days remaining.
        4. Return drugs where estimated days remaining <= low_days_threshold.

    Results are sorted by urgency (fewest days remaining first).

    Args:
        days_window:        Lookback period in days for velocity calculation.
        low_days_threshold: Alert cutoff — only include drugs estimated to
                            run out within this many days.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.id,
               d.name,
               d.brand,
               COALESCE(SUM(b.quantity), 0)                       AS quantity,
               MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS expiry_date,
               COALESCE(SUM(s.quantity_sold), 0)                   AS units_sold_recently
        FROM   drugs d
        LEFT   JOIN batches b ON b.drug_id = d.id
        LEFT   JOIN sales   s ON s.drug_id  = d.id
               AND  s.sale_date >= date('now', ? || ' days')
        GROUP  BY d.id
        HAVING units_sold_recently > 0 OR COALESCE(SUM(b.quantity), 0) = 0
        ORDER  BY units_sold_recently DESC
    """, (f"-{days_window}",))
    rows = cur.fetchall()
    conn.close()

    suggestions = []
    for r in rows:
        units_sold     = r[5]
        daily_velocity = units_sold / days_window
        days_remaining = (
            0 if r[3] == 0
            else round(r[3] / daily_velocity) if daily_velocity > 0
            else 9999
        )
        if days_remaining <= low_days_threshold:
            suggestions.append({
                "id":                  r[0],
                "name":                r[1],
                "brand":               r[2],
                "quantity":            r[3],
                "expiry_date":         r[4],
                "units_sold_recently": units_sold,
                "daily_velocity":      round(daily_velocity, 2),
                "days_remaining":      days_remaining,
                "suggested_reorder":   round(daily_velocity * 30),
            })

    suggestions.sort(key=lambda x: x["days_remaining"])
    return suggestions


# ---------------------------------------------------------------------------
# Dashboard KPIs
# ---------------------------------------------------------------------------

def get_dashboard_kpis() -> dict:
    """Real pharmacy KPIs: Today's Operations + Inventory Health."""
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""SELECT COALESCE(SUM(s.quantity_sold*d.price_per_unit),0)
        FROM sales s JOIN drugs d ON s.drug_id=d.id WHERE s.sale_date=date('now')""")
    today_revenue = round(cur.fetchone()[0], 2)
    cur.execute("""SELECT COUNT(*) FROM prescription_history
        WHERE upload_date=date('now') AND outcome IN ('sold','partial','cancelled')""")
    today_rx = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM prescription_history WHERE outcome='pending'")
    pending_rx = cur.fetchone()[0]
    cur.execute("""SELECT SUM(CASE WHEN outcome='sold' THEN 1 ELSE 0 END),
        SUM(CASE WHEN outcome='partial' THEN 1 ELSE 0 END),
        SUM(CASE WHEN outcome='cancelled' THEN 1 ELSE 0 END)
        FROM prescription_history WHERE outcome IN ('sold','partial','cancelled')""")
    row = cur.fetchone()
    sold,partial,cancelled = (row[0] or 0),(row[1] or 0),(row[2] or 0)
    total_completed = sold+partial+cancelled
    fill_rate = round(sold/total_completed*100,1) if total_completed>0 else 0.0
    cur.execute("""SELECT COUNT(*) FROM (SELECT d.id FROM drugs d
        LEFT JOIN batches b ON b.drug_id=d.id GROUP BY d.id
        HAVING COALESCE(SUM(b.quantity),0)=0)""")
    out_of_stock = cur.fetchone()[0]
    cur.execute("""SELECT COUNT(*) FROM (SELECT d.id FROM drugs d
        LEFT JOIN batches b ON b.drug_id=d.id GROUP BY d.id
        HAVING COALESCE(SUM(b.quantity),0)>0
        AND COALESCE(SUM(b.quantity),0)<=d.low_stock_threshold)""")
    low_stock = cur.fetchone()[0]
    cur.execute("""SELECT COUNT(DISTINCT drug_id) FROM batches WHERE quantity>0
        AND expiry_date IS NOT NULL AND date(expiry_date)>=date('now')
        AND date(expiry_date)<=date('now','+30 days')""")
    expiring_30d = cur.fetchone()[0]
    cur.execute("""SELECT COUNT(DISTINCT drug_id) FROM batches WHERE quantity>0
        AND expiry_date IS NOT NULL AND date(expiry_date)>=date('now')
        AND date(expiry_date)<=date('now','+90 days')""")
    expiring_soon = cur.fetchone()[0]
    cur.execute("""SELECT COUNT(DISTINCT drug_id) FROM batches WHERE quantity>0
        AND expiry_date IS NOT NULL AND date(expiry_date)<date('now')""")
    expired_count = cur.fetchone()[0]
    cur.execute("""SELECT COUNT(*),COALESCE(SUM(s.quantity_sold),0),
        COALESCE(SUM(s.quantity_sold*d.price_per_unit),0)
        FROM sales s JOIN drugs d ON s.drug_id=d.id""")
    transactions,units_sold,revenue = cur.fetchone()
    cur.execute("SELECT COUNT(*) FROM drugs")
    total_drugs = cur.fetchone()[0]
    cur.execute("SELECT COALESCE(SUM(quantity),0) FROM batches")
    total_stock = cur.fetchone()[0]
    conn.close()
    return {
        "today_revenue": today_revenue, "today_prescriptions": today_rx,
        "pending_prescriptions": pending_rx, "fill_rate": fill_rate,
        "out_of_stock_count": out_of_stock, "low_stock_count": low_stock,
        "expiring_30d": expiring_30d, "expired_count": expired_count,
        "expiring_soon": expiring_soon, "total_revenue": round(revenue,2),
        "total_transactions": transactions, "total_units_sold": units_sold,
        "total_drugs": total_drugs, "total_stock_units": total_stock,
    }

def get_prescription_fill_rate() -> dict:
    """
    Return prescription outcome breakdown and fill rate percentage.

    Fill rate = fully sold prescriptions / total non-pending prescriptions.
    This is the primary KPI pharmacy managers track daily.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT outcome, COUNT(*) AS count
        FROM   prescription_history
        WHERE  outcome != 'pending'
        GROUP  BY outcome
    """)
    rows   = {r[0]: r[1] for r in cur.fetchall()}
    cur.execute("SELECT COUNT(*) FROM prescription_history")
    total  = cur.fetchone()[0]
    conn.close()

    sold      = rows.get("sold",      0)
    partial   = rows.get("partial",   0)
    cancelled = rows.get("cancelled", 0)
    filled    = sold + partial
    non_pending = sold + partial + cancelled

    return {
        "total":       total,
        "sold":        sold,
        "partial":     partial,
        "cancelled":   cancelled,
        "fill_rate":   round((sold / non_pending * 100), 1) if non_pending > 0 else 0,
        "partial_rate": round((filled / non_pending * 100), 1) if non_pending > 0 else 0,
    }


def get_stock_turnover() -> list[dict]:
    """
    Return stock turnover rate per drug for the last 30 days.

    Turnover = units sold in period / average stock level.
    High turnover = fast mover, stockout risk.
    Low turnover  = slow mover, capital tied up.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT d.id,
               d.name,
               d.brand,
               COALESCE(SUM(b.quantity), 0)                       AS current_stock,
               d.low_stock_threshold,
               COALESCE(SUM(s.quantity_sold), 0)                   AS units_sold_30d,
               COALESCE(SUM(s.quantity_sold * d.price_per_unit), 0) AS revenue_30d
        FROM   drugs d
        LEFT   JOIN batches b ON b.drug_id = d.id
        LEFT   JOIN sales   s ON s.drug_id = d.id
               AND  s.sale_date >= date('now', '-30 days')
        GROUP  BY d.id
        ORDER  BY units_sold_30d DESC
    """)
    rows = cur.fetchall()
    conn.close()

    result = []
    for r in rows:
        current_stock  = r[3]
        units_sold_30d = r[5]
        # Avoid division by zero; use units sold as proxy when stock is 0
        avg_stock   = max(current_stock, units_sold_30d / 2) if units_sold_30d > 0 else current_stock
        turnover    = round(units_sold_30d / avg_stock, 2) if avg_stock > 0 else 0
        daily_usage = round(units_sold_30d / 30, 1)
        days_left   = round(current_stock / daily_usage) if daily_usage > 0 else None

        result.append({
            "id":            r[0],
            "name":          r[1],
            "brand":         r[2],
            "current_stock": current_stock,
            "threshold":     r[4],
            "units_sold_30d": units_sold_30d,
            "revenue_30d":   round(r[6], 2),
            "turnover_rate": turnover,
            "daily_usage":   daily_usage,
            "days_left":     days_left,
        })
    return result


def get_expiry_loss_summary() -> dict:
    """
    Return monthly expiry write-off summary from the writeoff_log.

    Tracks units and estimated value lost to expiry — a direct P&L impact
    that pharmacy managers monitor closely.
    """
    conn = get_connection()
    cur  = conn.cursor()

    cur.execute("""
        SELECT strftime('%Y-%m', w.writeoff_date) AS month,
               SUM(w.quantity)                     AS units_lost,
               SUM(w.quantity * d.price_per_unit)  AS value_lost
        FROM   writeoff_log w
        JOIN   drugs d ON d.id = w.drug_id
        GROUP  BY month
        ORDER  BY month ASC
    """)
    monthly = [
        {"month": r[0], "units_lost": r[1], "value_lost": round(r[2], 2)}
        for r in cur.fetchall()
    ]

    cur.execute("""
        SELECT COALESCE(SUM(w.quantity), 0),
               COALESCE(SUM(w.quantity * d.price_per_unit), 0)
        FROM   writeoff_log w
        JOIN   drugs d ON d.id = w.drug_id
    """)
    total_units, total_value = cur.fetchone()

    cur.execute("""
        SELECT d.name, SUM(w.quantity) AS units_lost
        FROM   writeoff_log w
        JOIN   drugs d ON d.id = w.drug_id
        GROUP  BY w.drug_id
        ORDER  BY units_lost DESC
        LIMIT  5
    """)
    top_losses = [{"name": r[0], "units_lost": r[1]} for r in cur.fetchall()]

    conn.close()
    return {
        "monthly":     monthly,
        "total_units": int(total_units),
        "total_value": round(total_value, 2),
        "top_losses":  top_losses,
    }


def get_avg_prescription_value() -> dict:
    """
    Return average prescription value and trend over the last 30 days.

    avg_value = total revenue / number of fully-sold prescriptions.
    Trending up = higher-value prescriptions being filled.
    """
    conn = get_connection()
    cur  = conn.cursor()

    # Overall average
    cur.execute("""
        SELECT COUNT(DISTINCT ph.id),
               COALESCE(SUM(s.quantity_sold * d.price_per_unit), 0)
        FROM   prescription_history ph
        JOIN   sales s ON s.sale_date = ph.upload_date
        JOIN   drugs d ON d.id = s.drug_id
        WHERE  ph.outcome IN ('sold', 'partial')
    """)
    rx_count, total_rev = cur.fetchone()
    avg_value = round(total_rev / rx_count, 2) if rx_count > 0 else 0

    # Daily average for trend chart
    cur.execute("""
        SELECT ph.upload_date,
               COALESCE(SUM(s.quantity_sold * d.price_per_unit), 0) AS daily_rev,
               COUNT(DISTINCT ph.id) AS rx_count
        FROM   prescription_history ph
        JOIN   sales s ON s.sale_date = ph.upload_date
        JOIN   drugs d ON d.id = s.drug_id
        WHERE  ph.outcome IN ('sold', 'partial')
          AND  ph.upload_date >= date('now', '-30 days')
        GROUP  BY ph.upload_date
        ORDER  BY ph.upload_date ASC
    """)
    trend = [
        {
            "date":      r[0],
            "avg_value": round(r[1] / r[2], 2) if r[2] > 0 else 0,
            "rx_count":  r[2],
        }
        for r in cur.fetchall()
    ]

    conn.close()
    return {
        "avg_value":  avg_value,
        "rx_count":   rx_count,
        "total_rev":  round(total_rev, 2),
        "trend":      trend,
    }



def mark_abandoned_prescriptions(stale_hours: int = 24) -> int:
    """
    Mark pending prescriptions as 'abandoned' if they have not been
    updated within stale_hours.

    A prescription is considered abandoned when:
      - Its outcome is still 'pending'
      - Its upload_date is older than stale_hours hours ago

    Called on every application startup so the history tab always shows
    accurate statuses without requiring a background worker.

    Args:
        stale_hours: Hours after which a pending prescription is abandoned.
                     Default is 24 hours.

    Returns:
        Number of records updated.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute(
        """
        UPDATE prescription_history
        SET    outcome = 'abandoned'
        WHERE  outcome = 'pending'
          AND  datetime(upload_date) < datetime('now', ? || ' hours')
        """,
        (f"-{stale_hours}",),
    )
    updated = cur.rowcount
    conn.commit()
    conn.close()
    return updated

# ---------------------------------------------------------------------------
# Prescription history
# ---------------------------------------------------------------------------

def save_prescription(
    image_bytes: bytes,
    extracted:   list,
    outcome:     str = "pending",
    notes:       str = "",
) -> int:
    """
    Persist a prescription upload to history.

    Args:
        image_bytes: Raw image data stored as a BLOB for later display.
        extracted:   List of medicine dicts returned by extract_prescription().
        outcome:     Initial status — always 'pending' until a sale is confirmed.
        notes:       Optional free-text notes attached to the record.

    Returns:
        The integer primary key of the new prescription_history row.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute(
        "INSERT INTO prescription_history "
        "(upload_date, image_data, extracted, outcome, notes) "
        "VALUES (?, ?, ?, ?, ?)",
        (date.today().isoformat(), image_bytes, json.dumps(extracted), outcome, notes),
    )
    record_id = cur.lastrowid
    conn.commit()
    conn.close()
    return record_id


def update_prescription_outcome(record_id: int, outcome: str) -> bool:
    """
    Update the outcome of a prescription after a sale is completed.

    Valid outcomes: 'sold', 'partial', 'cancelled'.

    Returns:
        True if the record was found and updated, False otherwise.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute(
        "UPDATE prescription_history SET outcome = ? WHERE id = ?",
        (outcome, record_id),
    )
    updated = cur.rowcount
    conn.commit()
    conn.close()
    return updated > 0


def get_prescription_history(limit: int = 50) -> list[dict]:
    """
    Return recent prescription records, newest first.

    Image BLOBs are excluded from this query for performance; use
    get_prescription_image() to retrieve a specific image.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT id, upload_date, extracted, outcome, notes
        FROM   prescription_history
        ORDER  BY id DESC
        LIMIT  ?
    """, (limit,))
    rows = cur.fetchall()
    conn.close()

    records = []
    for r in rows:
        medicines = json.loads(r[2]) if r[2] else []
        records.append({
            "id":          r[0],
            "upload_date": r[1],
            "extracted":   medicines,
            "outcome":     r[3],
            "notes":       r[4] or "",
            "drug_count":  len(medicines),
            "drugs":       ", ".join(m.get("drug_name", "?") for m in medicines),
            "notes_safe":  r[4] or "",
        })
    return records


def get_prescription_image(record_id: int) -> Optional[bytes]:
    """
    Return the raw image bytes for a prescription record.

    Returns None if the record does not exist or has no image attached.
    """
    conn = get_connection()
    cur  = conn.cursor()
    cur.execute(
        "SELECT image_data FROM prescription_history WHERE id = ?", (record_id,)
    )
    row = cur.fetchone()
    conn.close()
    return row[0] if row else None
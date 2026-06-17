"""
rag_agent.py
============
Prescription vision extraction for PharmAssist V2.

Sends a prescription image to Google Gemini 2.5 Flash and returns a
structured list of medicines with dosing information. This module is
the only place in the codebase that communicates with the Gemini API.

Extraction guarantees
---------------------
The prompt is engineered to produce reliable output from handwritten
prescriptions by enforcing four sequential reasoning steps:

    1. Count   — count all numbered drug entries before extracting any
    2. Name    — copy drug names character-for-character as written
    3. Dose    — sum morning/afternoon/night patterns (e.g. 1-0-1 = 2)
    4. Duration — convert weeks/months to days; apply shared durations

Anti-hallucination design
-------------------------
The model is explicitly instructed not to correct spelling or substitute
known drug names. If Gemini cannot read a word it must transcribe its
best character-level reading. This ensures that fuzzy matching in
db_utils.py — not the model's own knowledge — handles name resolution.

Supported input types
---------------------
    bytes        Raw image bytes from FastAPI's UploadFile.read()
    str / Path   File path — image read from disk

Environment
-----------
    GEMINI_API_KEY   Required. Set in .env or the process environment.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Union

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_MODEL = "gemini-2.5-flash"

_MIME_MAP: dict[str, str] = {
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".webp": "image/webp",
}

_DEFAULT_MIME = "image/jpeg"


# ---------------------------------------------------------------------------
# Gemini client — lazy initialisation
# ---------------------------------------------------------------------------
# Created on first use so a missing GEMINI_API_KEY raises a clear error
# when a prescription is uploaded, not at container startup.

_client: "genai.Client | None" = None


def _get_client() -> "genai.Client":
    """Return the Gemini client, creating it on first call."""
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError(
                "GEMINI_API_KEY is not set. Add it to .env locally or "
                "as a Secret in your Hugging Face Space settings."
            )
        _client = genai.Client(api_key=api_key)
    return _client


# ---------------------------------------------------------------------------
# Extraction prompt
# ---------------------------------------------------------------------------

_EXTRACTION_PROMPT = """\
You are an expert pharmacy assistant AI reading a SPECIFIC handwritten \
prescription image provided to you.

CRITICAL: You must ONLY extract what is ACTUALLY WRITTEN in this image.
Do NOT use your training knowledge to guess, fill in, or suggest drug names.
Do NOT hallucinate. If you cannot read a word clearly, write your best
character-by-character reading of what is physically written — even if it
seems like a misspelling.

Return ONLY this JSON structure — no markdown, no explanation, no code fences:
{
  "medicines": [
    {"drug_name": "DrugA", "frequency": 2, "duration": 3},
    {"drug_name": "DrugB", "frequency": 1, "duration": 5}
  ]
}

STEP 1 — COUNT THE DRUGS FIRST
Before extracting, count how many numbered items (1. 2. 3. 4. etc.) appear.
Your output MUST contain exactly that many entries. Never stop early.

STEP 2 — DRUG NAME
- Read the EXACT characters written — including suffixes (OZ, MR, NR, Plus)
- Do NOT correct spelling or substitute a "better known" drug name
- Example: written "OFLAZEST OZ" -> output "OFLAZEST OZ" (not "Ofloxacin")

STEP 3 — FREQUENCY (doses per day)
Prescriptions use morning-afternoon-night patterns. Always SUM all numbers:
  "1-0-1"  = 1+0+1 = 2       "1-1-1"  = 1+1+1 = 3
  "1-0-0"  = 1+0+0 = 1       "2-1-1"  = 2+1+1 = 4
  "once daily"=1  "twice daily"=2  "TID"=3  "QID"=4  "BD"/"BID"=2
  "every 6h"=4    "every 8h"=3     "every 12h"=2
NEVER take just the first number. Always SUM the entire pattern.

STEP 4 — DURATION
- "X days" -> X,  "X weeks" -> X x 7,  "X months" -> X x 30
- A single duration with a brace/bracket applies to ALL drugs under it
- If truly not visible, use null

FINAL CHECK
- Same number of drugs as counted in Step 1?
- Drug names copied exactly as written?
- Dosing pattern summed for every drug?
- Shared duration applied to all grouped drugs?
"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_prescription(image_input: Union[bytes, str, Path]) -> list[dict]:
    """
    Extract all medicines from a prescription image using Gemini Vision.

    The function sends the image to Gemini together with a structured
    prompt that guides the model through a four-step reasoning process.
    The raw JSON response is parsed and each medicine dict is enriched
    with a computed required_quantity field.

    Args:
        image_input: The prescription image in one of two forms:
            - bytes    Raw image bytes (from FastAPI UploadFile.read())
            - str/Path Path to an image file on disk

    Returns:
        A list of medicine dicts. Each dict contains:
            drug_name         (str | None)  Name as written on the prescription
            frequency         (int | None)  Doses per day
            duration          (int | None)  Treatment duration in days
            required_quantity (int | None)  frequency * duration

    Raises:
        ValueError: Gemini returned malformed JSON, or the response
                    contained no medicine entries.
        TypeError:  image_input is not a supported type.
    """
    image_bytes, mime_type = _read_image(image_input)

    response = _get_client().models.generate_content(
        model    = _MODEL,
        contents = [
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            types.Part.from_text(text=_EXTRACTION_PROMPT),
        ],
    )

    parsed    = _parse_response(response.text)
    medicines = parsed.get("medicines", [])

    if not medicines:
        raise ValueError(
            "No medicines were extracted from the prescription. "
            "The image may be unreadable or the prescription format is not supported. "
            "Please try again with a clearer image, or enter the details manually."
        )

    return [_enrich_medicine(medicine) for medicine in medicines]


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _read_image(image_input: Union[bytes, str, Path]) -> tuple[bytes, str]:
    """
    Normalise the two supported input types into a (bytes, mime_type) tuple.

    Args:
        image_input: bytes or a file path (str / pathlib.Path).

    Returns:
        (image_bytes, mime_type) ready for the Gemini API call.

    Raises:
        TypeError: image_input is not bytes or a path-like object.
    """
    if isinstance(image_input, bytes):
        # FastAPI callers pass await file.read() directly; MIME is assumed
        # JPEG because most phone photos and scanned prescriptions are JPEG.
        # The Gemini API accepts JPEG regardless of the actual file header.
        return image_input, _DEFAULT_MIME

    if isinstance(image_input, (str, Path)):
        path      = Path(image_input)
        mime_type = _MIME_MAP.get(path.suffix.lower(), _DEFAULT_MIME)
        return path.read_bytes(), mime_type

    raise TypeError(
        f"Unsupported image input type: {type(image_input).__name__}. "
        "Pass raw bytes from FastAPI UploadFile.read(), or a file path."
    )


def _parse_response(raw: str) -> dict:
    """
    Parse Gemini's text output into a Python dict.

    Gemini occasionally wraps its JSON in markdown code fences despite
    being instructed not to. This function strips those fences before
    parsing so the caller always receives a clean dict.

    Args:
        raw: The raw text string returned by the Gemini API.

    Returns:
        Parsed dict containing a 'medicines' key.

    Raises:
        ValueError: The text could not be parsed as valid JSON.
    """
    text = raw.strip()

    # Strip markdown code fences if present (```json ... ``` or ``` ... ```)
    if text.startswith("```"):
        parts = text.split("```")
        # parts[1] is the content between the first pair of fences
        text = parts[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(
            "Gemini returned invalid JSON. Please try again.\n"
            f"Response preview (first 300 characters): {text[:300]}\n"
            f"Parse error: {exc}"
        ) from exc


def _enrich_medicine(medicine: dict) -> dict:
    """
    Populate missing keys and compute required_quantity.

    Gemini may omit frequency or duration for medicines where those
    values could not be read. This function normalises the dict so
    every medicine always has the same set of keys, and computes
    required_quantity only when both inputs are available.

    Args:
        medicine: A single medicine dict as returned by Gemini.

    Returns:
        The same dict with guaranteed keys and required_quantity added.
    """
    medicine.setdefault("drug_name",  None)
    medicine.setdefault("frequency",  None)
    medicine.setdefault("duration",   None)

    frequency = medicine["frequency"]
    duration  = medicine["duration"]

    medicine["required_quantity"] = (
        frequency * duration
        if frequency and duration
        else None
    )

    return medicine
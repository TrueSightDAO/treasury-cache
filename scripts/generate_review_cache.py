#!/usr/bin/env python3
"""
Review Queue Cache Generator

Reads the Scored Chatlogs Google Sheet for rows with:
  - Status = "Pending Review" (Col F)
  - Cache Generated (Col N) is empty

Generates one JSON cache file per row in treasury-cache/review-queue/, then marks
Col N with a timestamp to prevent re-processing.

Cache filename: ``<safe_hash>__<sheet_row>.json``
  - The raw Scoring Hash Key (Col K) is NOT filesystem-safe (it can contain ``/`` and
    ``+``) and is NOT unique per row (a multi-contributor "split" contribution produces
    one row per contributor sharing the hash). So the filename sanitises the hash
    (``/``→``_``, ``+``→``-``, ``=`` dropped) and appends the sheet row number, which is
    unique per row. The real hash lives inside the JSON (``scoring_hash_key``).
  - Edgar deletes a row's cache file by the ``<safe_hash>__`` prefix on approval.

Environment variables:
  GOOGLE_APPLICATION_CREDENTIALS_JSON — Service account key JSON string
  SCORED_CHATLOGS_SHEET_ID — Google Sheet ID (default: 1Tbj7H5ur_egQLRugdXUaSIhEYIKp0vvVv2IZ7WTLCUo)
  REVIEW_QUEUE_DIR — Output directory (default: review-queue)
  BETA_MODE — If "true", writes to review-queue-test/ instead
"""

import json
import os
import sys
from datetime import datetime, timezone

# Google Sheets
import gspread
from google.oauth2.service_account import Credentials

# ── Configuration ──────────────────────────────────────────────────────

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SHEET_ID = os.environ.get(
    "SCORED_CHATLOGS_SHEET_ID",
    "1Tbj7H5ur_egQLRugdXUaSIhEYIKp0vvVv2IZ7WTLCUo",
)
SHEET_TAB = "Scored Chatlogs"
HEADER_ROW = 3  # Row 3 contains column headers
DATA_START_ROW = 4  # Data starts at row 4

REVIEW_QUEUE_DIR = os.environ.get("REVIEW_QUEUE_DIR", "review-queue")
BETA_MODE = os.environ.get("BETA_MODE", "false").lower() == "true"

if BETA_MODE:
    REVIEW_QUEUE_DIR = f"{REVIEW_QUEUE_DIR}-test"

# Column indices (0-indexed). Verified against the live sheet header (row 3):
# A Contributor Name | B Project Name | C Contribution Made | D Rubric classification |
# E TDGs Provisioned | F Status | G TDGs Issued | H Status date | I Existing Contributor |
# J Reporter Name | K Scoring Hash Key | … | N Cache Generated
COL_CONTRIBUTOR_NAME = 0       # A
COL_PROJECT_NAME = 1           # B
COL_CONTRIBUTION_DESC = 2      # C — Contribution Made (the actual work text)
COL_RUBRIC = 3                 # D — Rubric classification
COL_CONTRIBUTION_TYPE = 3      # D — (no dedicated type column; type is inside the text)
COL_TDGS_PROVISIONED = 4       # E
COL_STATUS = 5                 # F
COL_TDGS_ISSUED = 6            # G
COL_CONTRIBUTION_DATE = 7      # H — Status date
COL_FOUND_IN_CONTRIBUTORS = 8  # I — Existing Contributor
COL_REPORTER_NAME = 9          # J — Reporter Name
COL_HASH_KEY = 10              # K — Scoring Hash Key
COL_CACHE_GENERATED = 13       # N — Cache Generated

# ── Helpers ────────────────────────────────────────────────────────────

def _cell(row, idx):
    """Safe cell access — trailing empty columns are truncated by the Sheets API,
    so a Pending Review row (empty Col N) is usually shorter than 14 columns."""
    return (row[idx] if idx < len(row) else "") or ""


def safe_hash(hash_key):
    """Filesystem-safe form of a Scoring Hash Key (for filenames / Edgar deletion)."""
    return hash_key.replace("/", "_").replace("+", "-").replace("=", "")


def cache_filename(hash_key, actual_row):
    """Unique, filesystem-safe cache filename: <safe_hash>__<sheet_row>.json."""
    return f"{safe_hash(hash_key)}__{actual_row}.json"


def get_sheet():
    """Authenticate and return the worksheet."""
    creds_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if not creds_json:
        print("ERROR: GOOGLE_APPLICATION_CREDENTIALS_JSON not set", file=sys.stderr)
        sys.exit(1)

    creds_dict = json.loads(creds_json)
    creds = Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
    client = gspread.authorize(creds)
    sheet = client.open_by_key(SHEET_ID)
    worksheet = sheet.worksheet(SHEET_TAB)
    return worksheet


def get_all_rows(worksheet):
    """Fetch all data rows (from DATA_START_ROW) as a list of lists."""
    return worksheet.get(f"A{DATA_START_ROW}:O")


def find_pending_review_rows(rows):
    """
    Find rows needing cache generation:
    - Status (Col F) == "Pending Review"
    - Cache Generated (Col N) is empty
    - Hash Key (Col K) is non-empty
    """
    pending = []
    for i, row in enumerate(rows):
        if not row:
            continue
        status = _cell(row, COL_STATUS).strip()
        cache_gen = _cell(row, COL_CACHE_GENERATED).strip()
        hash_key = _cell(row, COL_HASH_KEY).strip()

        if status == "Pending Review" and not cache_gen and hash_key:
            pending.append((i, row))

    return pending


def build_cache_entry(row, actual_row):
    """Build a JSON-serializable cache entry from a sheet row."""
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scoring_hash_key": _cell(row, COL_HASH_KEY).strip(),
        "scored_chatlogs_row": actual_row,
        "contributor_name": _cell(row, COL_CONTRIBUTOR_NAME).strip(),
        "project_name": _cell(row, COL_PROJECT_NAME).strip(),
        "contribution_description": _cell(row, COL_CONTRIBUTION_DESC).strip(),
        "rubric": _cell(row, COL_RUBRIC).strip(),
        "contribution_type": _cell(row, COL_CONTRIBUTION_TYPE).strip(),
        "tdgs_provisioned": _cell(row, COL_TDGS_PROVISIONED).strip() or "0",
        "tdgs_issued": _cell(row, COL_TDGS_ISSUED).strip() or "0",
        "contribution_date": _cell(row, COL_CONTRIBUTION_DATE).strip(),
        "found_in_contributors": _cell(row, COL_FOUND_IN_CONTRIBUTORS).strip(),
        "reporter_name": _cell(row, COL_REPORTER_NAME).strip(),
        "status": _cell(row, COL_STATUS).strip(),
    }


def write_cache_file(hash_key, actual_row, entry):
    """Write a single JSON cache file to the review queue directory."""
    os.makedirs(REVIEW_QUEUE_DIR, exist_ok=True)
    filename = cache_filename(hash_key, actual_row)
    filepath = os.path.join(REVIEW_QUEUE_DIR, filename)
    with open(filepath, "w") as f:
        json.dump(entry, f, indent=2)
    print(f"  Wrote {filepath}")
    return filepath


def mark_cache_generated(worksheet, sheet_row_index, timestamp):
    """
    Mark Col N (Cache Generated) with the timestamp.
    sheet_row_index is the index into the rows array (0-based).
    The actual sheet row number is DATA_START_ROW + sheet_row_index.
    """
    actual_row = DATA_START_ROW + sheet_row_index
    # update_cell(row, col, value) is stable across gspread 5.x/6.x (unlike update(),
    # whose argument order changed). Col N = column 14.
    worksheet.update_cell(actual_row, 14, timestamp)


# ── Main ───────────────────────────────────────────────────────────────

def main():
    print(f"Connecting to sheet {SHEET_ID}...")
    worksheet = get_sheet()

    print("Fetching all rows...")
    rows = get_all_rows(worksheet)
    print(f"  Found {len(rows)} data rows")

    print("Scanning for pending review rows...")
    pending = find_pending_review_rows(rows)
    print(f"  Found {len(pending)} rows needing cache generation")

    if not pending:
        print("Nothing to do. Exiting.")
        return

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    generated_count = 0

    for sheet_row_index, row in pending:
        actual_row = DATA_START_ROW + sheet_row_index
        hash_key = _cell(row, COL_HASH_KEY).strip()
        print(f"\nProcessing row {actual_row} hash_key={hash_key}...")

        entry = build_cache_entry(row, actual_row)
        write_cache_file(hash_key, actual_row, entry)

        # Mark the sheet so this row isn't regenerated next run
        mark_cache_generated(worksheet, sheet_row_index, timestamp)
        print(f"  Marked sheet row {actual_row} as cached")

        generated_count += 1

    print(f"\nDone. Generated {generated_count} cache file(s) in {REVIEW_QUEUE_DIR}/")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Review Queue Cache Generator

Reads the Scored Chatlogs Google Sheet for rows with:
  - Status = "Pending Review" (Col F)
  - Cache Generated (Col N) is empty

Generates one JSON cache file per row in treasury-cache/review-queue/<hash_key>.json,
then marks Col N with a timestamp to prevent re-processing.

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

# Column indices (0-indexed from the sheet data array)
COL_STATUS = 5        # F — Status
COL_TDGS_PROVISIONED = 4  # E — TDGs Provisioned
COL_TDGS_ISSUED = 6       # G — TDGs Issued
COL_CONTRIBUTOR_NAME = 0  # A — Contributor Name
COL_CONTRIBUTION_DESC = 1 # B — Contribution Description
COL_RUBRIC = 2            # C — Rubric
COL_CONTRIBUTION_TYPE = 3 # D — Contribution Type
COL_CONTRIBUTION_DATE = 7 # H — Contribution Date
COL_FOUND_IN_CONTRIBUTORS = 8  # I — Found in Contributors
COL_CONTRIBUTOR_EMAIL = 9      # J — Contributor Email
COL_HASH_KEY = 10         # K — Scoring Hash Key
COL_CACHE_GENERATED = 13  # N — Cache Generated (NEW)

# ── Helpers ────────────────────────────────────────────────────────────

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
    """Fetch all rows from the sheet starting at DATA_START_ROW."""
    range_str = f"{SHEET_TAB}!A{O_DATA_START_ROW}:O"
    return worksheet.get(range_str)


def find_pending_review_rows(rows):
    """
    Find rows that need cache generation:
    - Status (Col F, index 5) == "Pending Review"
    - Cache Generated (Col N, index 13) is empty or None
    - Hash Key (Col K, index 10) is non-empty
    """
    pending = []
    for i, row in enumerate(rows):
        if not row or len(row) < 14:
            continue

        status = (row[COL_STATUS] or "").strip()
        cache_gen = (row[COL_CACHE_GENERATED] or "").strip()
        hash_key = (row[COL_HASH_KEY] or "").strip()

        if status == "Pending Review" and not cache_gen and hash_key:
            pending.append((i, row))

    return pending


def build_cache_entry(row):
    """Build a JSON-serializable cache entry from a sheet row."""
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scoring_hash_key": (row[COL_HASH_KEY] or "").strip(),
        "contributor_name": (row[COL_CONTRIBUTOR_NAME] or "").strip(),
        "contribution_description": (row[COL_CONTRIBUTION_DESC] or "").strip(),
        "rubric": (row[COL_RUBRIC] or "").strip(),
        "contribution_type": (row[COL_CONTRIBUTION_TYPE] or "").strip(),
        "tdgs_provisioned": (row[COL_TDGS_PROVISIONED] or "0").strip(),
        "tdgs_issued": (row[COL_TDGS_ISSUED] or "0").strip(),
        "contribution_date": (row[COL_CONTRIBUTION_DATE] or "").strip(),
        "found_in_contributors": (row[COL_FOUND_IN_CONTRIBUTORS] or "").strip(),
        "contributor_email": (row[COL_CONTRIBUTOR_EMAIL] or "").strip(),
        "status": (row[COL_STATUS] or "").strip(),
    }


def write_cache_file(hash_key, entry):
    """Write a single JSON cache file to the review queue directory."""
    os.makedirs(REVIEW_QUEUE_DIR, exist_ok=True)
    filename = f"{hash_key}.json"
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
    cell_range = f"N{actual_row}"
    worksheet.update(cell_range, [[timestamp]])


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
        hash_key = (row[COL_HASH_KEY] or "").strip()
        print(f"\nProcessing hash_key={hash_key}...")

        entry = build_cache_entry(row)
        write_cache_file(hash_key, entry)

        # Mark the sheet
        mark_cache_generated(worksheet, sheet_row_index, timestamp)
        print(f"  Marked sheet row {DATA_START_ROW + sheet_row_index} as cached")

        generated_count += 1

    print(f"\nDone. Generated {generated_count} cache file(s) in {REVIEW_QUEUE_DIR}/")


if __name__ == "__main__":
    main()

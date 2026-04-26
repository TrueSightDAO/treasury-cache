# treasury-cache

Pre-computed snapshot of the **TrueSight DAO off-chain treasury** — every inventory item across every managed ledger, with unit counts, unit cost, and warehouse-manager breakdown. Regenerated automatically; this repo is **write-by-automation, read-by-humans-and-AIs**.

**Do not hand-edit the JSON.** It is rebuilt by the `treasury-cache-publisher` Apps Script on every inventory movement and on a 30-minute safety-net cron. The `main` branch history is the audit trail.

## Canonical files

| | |
|---|---|
| **Branch** | `main` |
| **Treasury snapshot** | [`dao_offchain_treasury.json`](dao_offchain_treasury.json) |
| **Raw URL (browsers / `fetch`)** | `https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/dao_offchain_treasury.json` |
| **Human sanity-check** | [`SNAPSHOT.md`](SNAPSHOT.md) (regenerated each run) |
| **Publisher GAS source** | [`gas/treasury-cache-publisher/`](gas/treasury-cache-publisher/) |

## Source of truth

The authoritative data lives in Google Sheets:

- **Main Ledger** (`1GE7PUq-UT6x2rBN-Q2ksogbWpgyuh2SaxJyG_uEK6PU`) — sheet `offchain asset location` (rows starting at row 5, columns A=currency, B=manager, C=amount, D=unit cost USD, E=total value).
- **Shipment Ledger Listing** tab — config for every managed AGL ledger (column A=name, column AB=resolved spreadsheet URL).
- **Every managed AGL ledger** (external spreadsheets per-shipment) — sheet `Balance`, rows starting at row 6, columns H=manager, I=quantity, J=asset.
- **Currencies** tab — canonical catalog (unit cost, unit weight, **Inventory Type** col P, **Unit format** col Q), joined by currency name; enriches aggregated `items` and each `managers[].items[]` row in the JSON.

If this JSON looks wrong, the Sheets are authoritative. Regenerate by calling the publisher webhook (see [`gas/treasury-cache-publisher/README.md`](gas/treasury-cache-publisher/README.md)) — do **not** edit the JSON directly; the next run will overwrite your change.

## JSON schema (v3)

`schema_version` **3** adds optional **`inventory_type`** and **`unit_format`** on each aggregate `items[]` row and on each `managers[].items[]` line, copied from Main Ledger **Currencies** columns P and Q when the currency name matches. Older consumers may ignore these keys; they are `null` when the sheet cell is blank or the name is not in Currencies.

```json
{
  "generated_at": "2026-04-21T19:56:10Z",
  "source": "treasury-cache-publisher",
  "trigger": "movement",
  "schema_version": 3,

  "items": [
    {
      "currency": "Oscar Bahia Ceremonial Cacao 200g",
      "unit_weight_g": 200,
      "unit_cost_usd": 7.12,
      "inventory_type": "Cacao Bean",
      "unit_format": "Retail ready",
      "total_quantity": 68,
      "total_value_usd": 484.16,
      "ledgers": {
        "Main Ledger": 12,
        "AGL14": 40,
        "AGL15": 16
      }
    }
  ],

  "managers": [
    {
      "manager_name": "Matheus Reis",
      "manager_key": "Matheus%20Reis",
      "items": [
        {
          "currency": "[AGL14] Oscar Bahia Ceremonial Cacao 200g",
          "amount": 40,
          "ledger": "AGL14",
          "unit_weight_g": 200,
          "unit_cost_usd": 7.12,
          "inventory_type": "Cacao Bean",
          "unit_format": "Retail ready",
          "total_value_usd": 284.80
        }
      ]
    }
  ],

  "ledgers": [
    { "ledger_name": "AGL14", "ledger_url": "https://truesight.me/..." }
  ],

  "totals": {
    "item_types": 42,
    "total_units": 1234,
    "total_value_usd": 9876.54,
    "ledgers_processed": 15,
    "managers_count": 38
  }
}
```

### Changelog

- **v3 (2026-04-26)** — optional **`inventory_type`** and **`unit_format`** on `items[]` and `managers[].items[]`, from Main Ledger **Currencies** columns P and Q (matched by currency name). Additive; older clients may ignore.
- **v2 (2026-04-21)** — added `unit_weight_g` to `managers[].items[]` (needed by `shipping_planner.html` → `get_inventory` compat). `schema_version` bumped. Additive only; v1 consumers keep working.
- **v1 (2026-04-21)** — initial release.

### Field notes

- **`items[].ledgers`** is a map, not an array: each key is a ledger name (e.g. `"AGL14"`, or `"Main Ledger"` for direct offchain-asset-location rows), each value is the quantity held in that ledger. Sum of values equals `total_quantity`.
- **`items[].unit_cost_usd`** comes from the Main Ledger `Currencies` tab column B. It is `null` when unknown.
- **`items[].inventory_type`** / **`items[].unit_format`** (v3+) come from `Currencies` columns P and Q when the name matches; `null` if blank or unknown.
- **`managers[].items[].currency`** uses the same `[AGLn] <asset>` prefix convention the DApp renders, so consumers can keep using it verbatim.
- **`managers[].items[].ledger`** is the ledger name (e.g. `"AGL14"`) or `"Main Ledger"` for `offchain asset location` rows.
- **`trigger`** is one of `movement` (posted by the tokenomics movement processor), `cron` (30-minute safety-net), or `manual` (`?action=publish` force-refresh).

### Schema stability

`schema_version` is bumped on breaking changes and on material additive changes we want consumers to notice (e.g. v3 catalog dimensions). Consumers should check it on load and fail loudly only if they require a cap they do not support. Optional new keys may appear without breaking strict parsers that allow unknown properties.

## Consumers

- **DApp** (`dapp/report_inventory_movement.html`) — renders Warehouse Manager + Inventory Item dropdowns from this file instead of fanning out to the `tdg_inventory_management` GAS on every page load.
- **External AI / integrations** — treat the raw URL as a read-only public JSON feed. It is eventually consistent (staleness bounded by the 30-minute cron).

## Update cadence

- **Event-driven** — every inventory movement processed by `tokenomics/google_app_scripts/tdg_inventory_management/process_movement_telegram_logs.gs` posts to the publisher webhook. Expected latency Sheets → cache: < 1 min.
- **Time-driven** — Apps Script time trigger on the publisher project, every 30 min. Bounds worst-case staleness if a movement-trigger ever fails.
- **Manual** — `GET <publisher-webhook>?action=publish&token=<TREASURY_CACHE_PUBLISH_SECRET>&trigger=manual` forces a regen.

## Related

- Publisher GAS source + runbook: [`gas/treasury-cache-publisher/`](gas/treasury-cache-publisher/)
- Sibling repo for store-facing inventory: [`agroverse-inventory`](https://github.com/TrueSightDAO/agroverse-inventory) (different purpose: SKU → count for the Agroverse store, not internal treasury).

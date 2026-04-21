# treasury-cache-publisher (Apps Script)

Regenerates [`dao_offchain_treasury.json`](../../dao_offchain_treasury.json) + [`SNAPSHOT.md`](../../SNAPSHOT.md) and commits both to `main` via the GitHub Contents API.

- **Apps Script editor:** https://script.google.com/home/projects/1u4lVtGaO5GjpG0XQo7b8hc3QFAXcsrJKclBead2sDcgvatMdE6dm3mzx/edit
- **Webhook (web app):** https://script.google.com/macros/s/AKfycbyBmjwmFhR8nQ5ZCtdqQwr-OgC5-htdFnMeXOKLD-Z-NWvNpLGvi7nPbMQVvnhrnbSXdQ/exec

## Required script properties

Set these in **Project Settings → Script properties**:

| Key | Value |
|---|---|
| `TREASURY_CACHE_PAT` | GitHub fine-grained PAT, `contents:write` on `TrueSightDAO/treasury-cache` |
| `TREASURY_CACHE_PUBLISH_SECRET` | Strong random string; required query-string token for `?action=publish` |

Optional overrides (defaults shown):

| Key | Default |
|---|---|
| `INVENTORY_SPREADSHEET_ID` | `1GE7PUq-UT6x2rBN-Q2ksogbWpgyuh2SaxJyG_uEK6PU` (Main Ledger) |
| `TREASURY_CACHE_GITHUB_OWNER` | `TrueSightDAO` |
| `TREASURY_CACHE_GITHUB_REPO` | `treasury-cache` |
| `TREASURY_CACHE_GITHUB_BRANCH` | `main` |

## First-time authorization

1. Open the editor, select the function `testPublishTreasuryCache`, click **Run**.
2. Google will prompt for OAuth — grant access to Spreadsheets, external HTTP, and scripts (matches `appsscript.json`).
3. Check the execution log: you should see a non-empty `totals` block and `github_json.ok = true`.
4. Confirm the repo now has `dao_offchain_treasury.json` + `SNAPSHOT.md` on `main`.

## Triggers

### Time-driven (30-min safety net)

In the editor: **Triggers → Add Trigger** →
- Function: `publishTreasuryCacheCron`
- Event source: Time-driven
- Type: Minutes timer → Every 30 minutes

### Event-driven (movement hook)

Wired from `tokenomics/google_app_scripts/tdg_inventory_management/process_movement_telegram_logs.gs`
at the end of `processTelegramChatLogsToInventoryMovement()` when `stats.rowsAddedToMovement > 0`:

```js
UrlFetchApp.fetch(
  'https://script.google.com/macros/s/AKfycbyBmjwmFhR8nQ5ZCtdqQwr-OgC5-htdFnMeXOKLD-Z-NWvNpLGvi7nPbMQVvnhrnbSXdQ/exec'
    + '?action=publish&trigger=movement'
    + '&token=' + encodeURIComponent(
        PropertiesService.getScriptProperties().getProperty('TREASURY_CACHE_PUBLISH_SECRET')
      ),
  { method: 'get', muteHttpExceptions: true, followRedirects: true }
);
```

### Manual

```
GET <webhook>?action=publish&token=<TREASURY_CACHE_PUBLISH_SECRET>&trigger=manual
GET <webhook>?action=ping
```

## Deploying code changes (clasp)

```
cd ~/Applications/treasury-cache/gas/treasury-cache-publisher
# one-time:
clasp clone 1u4lVtGaO5GjpG0XQo7b8hc3QFAXcsrJKclBead2sDcgvatMdE6dm3mzx --rootDir .
# routine:
clasp push
```

After pushing new code, redeploy the web-app version (Editor → Deploy → Manage deployments → Edit → New version) so the webhook URL keeps serving latest code.

## Business logic provenance

Aggregation mirrors `tokenomics/google_app_scripts/tdg_inventory_management/web_app.gs`:

- `listAllCurrenciesAcrossLedgers` → items[] across ledgers
- `getLedgerConfigsFromSheet` → walks "Shipment Ledger Listing" (A=name, AB=resolved spreadsheet URL)
- `augmentWithLedgers` → per-manager AGL aggregation
- Unit cost: `Currencies` tab (A=name, B=unit_cost_usd, K=unit_weight_g)

If the source sheets change schema, update `Code.gs` and bump `SCHEMA_VERSION` if the output JSON shape changes.

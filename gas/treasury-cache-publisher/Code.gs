/**
 * File: gas/treasury-cache-publisher/Code.gs
 * Repository: https://github.com/TrueSightDAO/treasury-cache
 * Apps Script editor:
 *   https://script.google.com/home/projects/1u4lVtGaO5GjpG0XQo7b8hc3QFAXcsrJKclBead2sDcgvatMdE6dm3mzx/edit
 * Web app:
 *   https://script.google.com/macros/s/AKfycbyBmjwmFhR8nQ5ZCtdqQwr-OgC5-htdFnMeXOKLD-Z-NWvNpLGvi7nPbMQVvnhrnbSXdQ/exec
 *
 * Reads every managed ledger configured in the Main Ledger's "Shipment Ledger
 * Listing" tab, plus the main "offchain asset location" sheet, aggregates every
 * inventory item across every ledger + warehouse manager, and commits the
 * result to TrueSightDAO/treasury-cache/main as dao_offchain_treasury.json
 * (+ a human-readable SNAPSHOT.md) via the GitHub Contents API.
 *
 * Triggers (all call publishTreasuryCache_):
 *   - HTTP: GET ?action=publish&token=<TREASURY_CACHE_PUBLISH_SECRET>&trigger=movement|cron|manual
 *   - Time-driven: publishTreasuryCacheCron (install via Apps Script Triggers UI)
 *
 * Script properties (set in Project Settings → Script properties):
 *   - TREASURY_CACHE_PAT              (GitHub fine-grained PAT, contents:write on treasury-cache)
 *   - TREASURY_CACHE_PUBLISH_SECRET   (shared secret for the HTTP trigger)
 *   - INVENTORY_SPREADSHEET_ID        (default: Main Ledger 1GE7PUq-...)
 *   - TREASURY_CACHE_GITHUB_OWNER     (default: TrueSightDAO)
 *   - TREASURY_CACHE_GITHUB_REPO      (default: treasury-cache)
 *   - TREASURY_CACHE_GITHUB_BRANCH    (default: main)
 *
 * Aggregation logic mirrors tokenomics/google_app_scripts/tdg_inventory_management/web_app.gs
 * (listAllCurrenciesAcrossLedgers, getLedgerConfigsFromSheet, augmentWithLedgers).
 */

// ---------- Constants / defaults ----------

var DEFAULT_INVENTORY_SPREADSHEET_ID = '1GE7PUq-UT6x2rBN-Q2ksogbWpgyuh2SaxJyG_uEK6PU';
var DEFAULT_GH_OWNER  = 'TrueSightDAO';
var DEFAULT_GH_REPO   = 'treasury-cache';
var DEFAULT_GH_BRANCH = 'main';

var JSON_PATH = 'dao_offchain_treasury.json';
var MD_PATH   = 'SNAPSHOT.md';

var MAIN_SHEET_NAME           = 'offchain asset location';
var SHIPMENT_LEDGER_LISTING   = 'Shipment Ledger Listing';
var CURRENCIES_SHEET_NAME     = 'Currencies';

var SCHEMA_VERSION = 1;
var LOCK_TIMEOUT_MS = 30000;

// ---------- Script property helpers ----------

function prop_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v && String(v).trim()) ? String(v).trim() : fallback;
}

function mustProp_(key) {
  var v = prop_(key, '');
  if (!v) throw new Error('Missing required script property: ' + key);
  return v;
}

function jsonResponse_(obj, code) {
  var out = ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  return out;
}

// ---------- Entry points ----------

function doGet(e) {
  var action = (e && e.parameter ? String(e.parameter.action || '') : '').trim();

  if (action === 'ping') {
    return jsonResponse_({ ok: true, service: 'treasury-cache-publisher', schema_version: SCHEMA_VERSION });
  }

  if (action === 'publish') {
    var token = (e && e.parameter ? String(e.parameter.token || '') : '').trim();
    var expected = prop_('TREASURY_CACHE_PUBLISH_SECRET', '');
    if (!expected || token !== expected) {
      return jsonResponse_({ ok: false, error: 'unauthorized' });
    }
    var trigger = (e.parameter.trigger || 'manual').toString().trim() || 'manual';
    return jsonResponse_(publishTreasuryCache_(trigger));
  }

  return jsonResponse_({
    ok: true,
    service: 'treasury-cache-publisher',
    schema_version: SCHEMA_VERSION,
    hint: 'GET ?action=publish&token=<secret>&trigger=movement|cron|manual to regenerate and commit the treasury snapshot.'
  });
}

// Called by the installable time-driven trigger. Wraps publishTreasuryCache_
// with a fixed trigger label so SNAPSHOT.md shows the right origin.
function publishTreasuryCacheCron() {
  return publishTreasuryCache_('cron');
}

// Manual editor-console entry point for first-run testing. Uses trigger=manual.
function testPublishTreasuryCache() {
  var result = publishTreasuryCache_('manual');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// ---------- Publish orchestration ----------

function publishTreasuryCache_(trigger) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { ok: false, error: 'busy', trigger: trigger };
  }
  try {
    var snapshot = buildSnapshot_(trigger);
    var md = renderMarkdown_(snapshot);

    var commitMessage = 'chore(treasury): snapshot @ ' + snapshot.generated_at +
      ' (trigger=' + trigger + ')';

    var jsonResult = putGitHubJsonAtPath_(JSON_PATH, commitMessage, snapshot);
    var mdResult   = putGitHubTextAtPath_(MD_PATH,   commitMessage, md);

    return {
      ok: jsonResult.ok && mdResult.ok,
      trigger: trigger,
      generated_at: snapshot.generated_at,
      totals: snapshot.totals,
      github_json: { ok: jsonResult.ok, sha: jsonResult.sha, message: jsonResult.message },
      github_md:   { ok: mdResult.ok,   sha: mdResult.sha,   message: mdResult.message }
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), trigger: trigger };
  } finally {
    lock.releaseLock();
  }
}

// ---------- Aggregation ----------

function buildSnapshot_(trigger) {
  var spreadsheetId = prop_('INVENTORY_SPREADSHEET_ID', DEFAULT_INVENTORY_SPREADSHEET_ID);
  var ss = SpreadsheetApp.openById(spreadsheetId);

  var currenciesMap = getCurrenciesMap_(ss); // { name: { unit_cost_usd, unit_weight_g } }
  var ledgerConfigs = getLedgerConfigsFromSheet_(ss);

  // items[] indexed by canonical currency string (bare name)
  var itemsByName = {};

  // managers[] indexed by manager name
  var managersByName = {};

  function ensureItem(name) {
    if (!itemsByName[name]) {
      var meta = currenciesMap[name] || {};
      itemsByName[name] = {
        currency: name,
        unit_weight_g: meta.unit_weight_g != null ? meta.unit_weight_g : null,
        unit_cost_usd: meta.unit_cost_usd != null ? meta.unit_cost_usd : null,
        total_quantity: 0,
        total_value_usd: 0,
        ledgers: {}
      };
    }
    return itemsByName[name];
  }

  function ensureManager(name) {
    if (!managersByName[name]) {
      managersByName[name] = {
        manager_name: name,
        manager_key: encodeURIComponent(name),
        items: []
      };
    }
    return managersByName[name];
  }

  // 1) Main Ledger: "offchain asset location" sheet, rows 5+, cols A..E
  var mainSheet = ss.getSheetByName(MAIN_SHEET_NAME);
  if (mainSheet) {
    var lastRow = mainSheet.getLastRow();
    var numRows = Math.max(0, lastRow - 4);
    var mainRows = numRows > 0 ? mainSheet.getRange(5, 1, numRows, 5).getValues() : [];
    mainRows.forEach(function(row) {
      var currency = row[0] ? String(row[0]).trim() : '';
      var managerName = row[1] ? String(row[1]).trim() : '';
      var amount = parseFloat(row[2]);
      var unitCostRaw = row[3];
      var totalValRaw = row[4];

      if (!currency || !(amount > 0)) return;

      var item = ensureItem(currency);
      item.total_quantity += amount;
      item.ledgers['Main Ledger'] = (item.ledgers['Main Ledger'] || 0) + amount;

      if (managerName) {
        var mgr = ensureManager(managerName);
        var mgrEntry = {
          currency: currency,
          amount: amount,
          ledger: 'Main Ledger'
        };
        var uc = parseFloat(unitCostRaw);
        if (!isNaN(uc)) mgrEntry.unit_cost_usd = uc;
        var tv = parseFloat(totalValRaw);
        if (!isNaN(tv)) mgrEntry.total_value_usd = tv;
        // Fallback compute if main sheet didn't populate E but Currencies catalog knows unit cost
        if (mgrEntry.total_value_usd == null && mgrEntry.unit_cost_usd != null) {
          mgrEntry.total_value_usd = round2_(amount * mgrEntry.unit_cost_usd);
        }
        mgr.items.push(mgrEntry);
      }
    });
  }

  // 2) Every AGL ledger listed in Shipment Ledger Listing: Balance sheet, rows 6+
  var ledgersProcessed = 0;
  ledgerConfigs.forEach(function(config) {
    try {
      var spreadsheetUrl = config.ledger_spreadsheet_url || config.ledger_url;
      if (!spreadsheetUrl || spreadsheetUrl.indexOf('docs.google.com/spreadsheets') < 0) return;

      var ledgerSs = SpreadsheetApp.openByUrl(spreadsheetUrl);
      var balanceSheet = ledgerSs.getSheetByName(config.sheet_name);
      if (!balanceSheet) return;

      var startRow = config.record_start_row;
      var lastLedgerRow = balanceSheet.getLastRow();
      var numLedgerRows = Math.max(0, lastLedgerRow - startRow + 1);
      if (numLedgerRows < 1) return;

      var nameCol  = letterToColumn_(config.manager_names_column);
      var assetCol = letterToColumn_(config.asset_name_column);
      var qtyCol   = letterToColumn_(config.asset_quantity_column);

      var names  = balanceSheet.getRange(startRow, nameCol,  numLedgerRows, 1).getValues();
      var assets = balanceSheet.getRange(startRow, assetCol, numLedgerRows, 1).getValues();
      var qtys   = balanceSheet.getRange(startRow, qtyCol,   numLedgerRows, 1).getValues();

      for (var i = 0; i < names.length; i++) {
        var managerName = names[i][0] ? String(names[i][0]).trim() : '';
        var assetName = assets[i][0] ? String(assets[i][0]).trim() : '';
        var quantity = parseFloat(qtys[i][0]);

        if (!assetName || !(quantity > 0)) continue;

        var item = ensureItem(assetName);
        item.total_quantity += quantity;
        item.ledgers[config.ledger_name] = (item.ledgers[config.ledger_name] || 0) + quantity;

        if (managerName) {
          var prefixedName = '[' + config.ledger_name + '] ' + assetName;
          var unitCost = resolveUnitCost_(currenciesMap, prefixedName, assetName);

          var mgr = ensureManager(managerName);
          var mgrEntry = {
            currency: prefixedName,
            amount: quantity,
            ledger: config.ledger_name
          };
          if (unitCost != null) {
            mgrEntry.unit_cost_usd = unitCost;
            mgrEntry.total_value_usd = round2_(quantity * unitCost);
          }
          mgr.items.push(mgrEntry);
        }
      }

      ledgersProcessed++;
    } catch (err) {
      Logger.log('Error processing ledger ' + config.ledger_name + ': ' + err);
    }
  });

  // Finalize items: compute total_value_usd, filter zero, sort
  var items = [];
  Object.keys(itemsByName).forEach(function(name) {
    var it = itemsByName[name];
    if (!(it.total_quantity > 0)) return;
    it.total_value_usd = it.unit_cost_usd != null
      ? round2_(it.total_quantity * it.unit_cost_usd)
      : null;
    items.push(it);
  });
  items.sort(function(a, b) { return b.total_quantity - a.total_quantity; });

  // Finalize managers: sort each manager's items by ledger then currency
  var managers = Object.keys(managersByName).map(function(k) {
    var m = managersByName[k];
    m.items.sort(function(a, b) {
      if (a.ledger !== b.ledger) return a.ledger < b.ledger ? -1 : 1;
      return a.currency < b.currency ? -1 : 1;
    });
    return m;
  });
  managers.sort(function(a, b) {
    return a.manager_name.toLowerCase() < b.manager_name.toLowerCase() ? -1 : 1;
  });

  var totalUnits = items.reduce(function(s, it) { return s + it.total_quantity; }, 0);
  var totalValue = items.reduce(function(s, it) {
    return s + (it.total_value_usd != null ? it.total_value_usd : 0);
  }, 0);

  return {
    generated_at: new Date().toISOString(),
    source: 'treasury-cache-publisher',
    trigger: trigger,
    schema_version: SCHEMA_VERSION,
    items: items,
    managers: managers,
    ledgers: ledgerConfigs.map(function(c) {
      return { ledger_name: c.ledger_name, ledger_url: c.ledger_url };
    }),
    totals: {
      item_types: items.length,
      total_units: totalUnits,
      total_value_usd: round2_(totalValue),
      ledgers_processed: ledgersProcessed,
      managers_count: managers.length
    }
  };
}

// Reads "Shipment Ledger Listing" → array of { ledger_name, ledger_url,
// ledger_spreadsheet_url, sheet_name, manager_names_column, asset_name_column,
// asset_quantity_column, record_start_row }. Mirrors
// tdg_inventory_management/web_app.gs::getLedgerConfigsFromSheet.
function getLedgerConfigsFromSheet_(mainSs) {
  var sheet = mainSs.getSheetByName(SHIPMENT_LEDGER_LISTING);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var data = sheet.getRange(2, 1, Math.max(2, lastRow - 1), 28).getValues();
  var configs = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var ledgerName = row[0]  ? String(row[0]).trim()  : '';   // A
    var viewUrl    = row[10] ? String(row[10]).trim() : '';   // K
    var resolved   = row[27] ? String(row[27]).trim() : '';   // AB

    if (!ledgerName || ledgerName === '0') continue;
    if (!resolved || resolved.indexOf('docs.google.com/spreadsheets') < 0) continue;

    configs.push({
      ledger_name: ledgerName,
      ledger_url: viewUrl || resolved,
      ledger_spreadsheet_url: resolved,
      sheet_name: 'Balance',
      manager_names_column: 'H',
      asset_name_column: 'J',
      asset_quantity_column: 'I',
      record_start_row: 6
    });
  }
  return configs;
}

// Read the Main Ledger Currencies tab once: name (A) → { unit_cost_usd (B), unit_weight_g (K) }
function getCurrenciesMap_(mainSs) {
  var map = {};
  var sheet = mainSs.getSheetByName(CURRENCIES_SHEET_NAME);
  if (!sheet) return map;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;

  // Columns A..K (11 cols) — A=name, B=unit_cost_usd, K=unit_weight_g
  var rows = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  rows.forEach(function(row) {
    var name = row[0] ? String(row[0]).trim() : '';
    if (!name) return;
    var cost = parseFloat(row[1]);
    var weight = parseFloat(row[10]);
    map[name] = {
      unit_cost_usd: isNaN(cost) ? null : cost,
      unit_weight_g: isNaN(weight) || !(weight > 0) ? null : weight
    };
  });
  return map;
}

// Prefixed AGL name first (e.g. "[AGL14] Oscar..."), then bare asset name.
function resolveUnitCost_(currenciesMap, prefixedName, assetName) {
  var byPrefix = currenciesMap[prefixedName];
  if (byPrefix && byPrefix.unit_cost_usd != null) return byPrefix.unit_cost_usd;
  var byBare = currenciesMap[assetName];
  if (byBare && byBare.unit_cost_usd != null) return byBare.unit_cost_usd;
  return null;
}

function letterToColumn_(letter) {
  var col = 0;
  for (var i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
  }
  return col;
}

function round2_(n) {
  if (n == null || isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

// ---------- Markdown rendering (SNAPSHOT.md) ----------

function renderMarkdown_(snapshot) {
  var lines = [];
  lines.push('# Treasury snapshot');
  lines.push('');
  lines.push('> **Auto-generated.** Do not hand-edit — the next `treasury-cache-publisher` run will overwrite this file.');
  lines.push('> Authoritative data lives in Google Sheets (see `README.md`). This file is a human sanity-check only.');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push('| Generated at | `' + snapshot.generated_at + '` |');
  lines.push('| Trigger | `' + snapshot.trigger + '` |');
  lines.push('| Schema version | `' + snapshot.schema_version + '` |');
  lines.push('| Item types | ' + snapshot.totals.item_types + ' |');
  lines.push('| Total units | ' + snapshot.totals.total_units + ' |');
  lines.push('| Total value USD | ' + (snapshot.totals.total_value_usd != null ? '$' + snapshot.totals.total_value_usd.toFixed(2) : '—') + ' |');
  lines.push('| Ledgers processed | ' + snapshot.totals.ledgers_processed + ' |');
  lines.push('| Managers | ' + snapshot.totals.managers_count + ' |');
  lines.push('');

  // Full items table, sorted by total quantity desc
  lines.push('## Items (' + snapshot.items.length + ', sorted by total quantity)');
  lines.push('');
  lines.push('| Currency | Units | Unit cost USD | Total value USD | Ledgers |');
  lines.push('|---|---:|---:|---:|---|');
  snapshot.items.forEach(function(it) {
    var cost = it.unit_cost_usd != null ? '$' + it.unit_cost_usd.toFixed(2) : '—';
    var tv = it.total_value_usd != null ? '$' + it.total_value_usd.toFixed(2) : '—';
    var ledgerStr = Object.keys(it.ledgers).sort().map(function(k) {
      return k + ': ' + it.ledgers[k];
    }).join(', ');
    lines.push('| ' + escapePipes_(it.currency) + ' | ' + it.total_quantity + ' | ' + cost + ' | ' + tv + ' | ' + escapePipes_(ledgerStr) + ' |');
  });
  lines.push('');

  // Per-ledger unit totals
  lines.push('## Per-ledger totals');
  lines.push('');
  lines.push('| Ledger | Distinct items | Total units |');
  lines.push('|---|---:|---:|');
  var perLedger = {};
  snapshot.items.forEach(function(it) {
    Object.keys(it.ledgers).forEach(function(lname) {
      if (!perLedger[lname]) perLedger[lname] = { items: 0, units: 0 };
      perLedger[lname].items += 1;
      perLedger[lname].units += it.ledgers[lname];
    });
  });
  Object.keys(perLedger).sort().forEach(function(lname) {
    lines.push('| ' + escapePipes_(lname) + ' | ' + perLedger[lname].items + ' | ' + perLedger[lname].units + ' |');
  });
  lines.push('');

  // Managers summary
  lines.push('## Managers (' + snapshot.managers.length + ')');
  lines.push('');
  lines.push('| Manager | Line items | Total units |');
  lines.push('|---|---:|---:|');
  snapshot.managers.forEach(function(m) {
    var units = m.items.reduce(function(s, it) { return s + (parseFloat(it.amount) || 0); }, 0);
    lines.push('| ' + escapePipes_(m.manager_name) + ' | ' + m.items.length + ' | ' + units + ' |');
  });
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('Raw JSON: [`dao_offchain_treasury.json`](dao_offchain_treasury.json)');
  lines.push('');
  return lines.join('\n');
}

function escapePipes_(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

// ---------- GitHub Contents API ----------

function gitHubTarget_() {
  return {
    owner:  prop_('TREASURY_CACHE_GITHUB_OWNER',  DEFAULT_GH_OWNER),
    repo:   prop_('TREASURY_CACHE_GITHUB_REPO',   DEFAULT_GH_REPO),
    branch: prop_('TREASURY_CACHE_GITHUB_BRANCH', DEFAULT_GH_BRANCH),
    pat:    mustProp_('TREASURY_CACHE_PAT')
  };
}

function putGitHubJsonAtPath_(relativePath, commitMessage, jsonObj) {
  var body = JSON.stringify(jsonObj, null, 2) + '\n';
  return putGitHubFile_(relativePath, commitMessage, body);
}

function putGitHubTextAtPath_(relativePath, commitMessage, text) {
  return putGitHubFile_(relativePath, commitMessage, text);
}

// Writes text content to `relativePath` on the configured branch via the
// GitHub Contents API (GET sha → PUT with sha). Returns { ok, sha, message }.
function putGitHubFile_(relativePath, commitMessage, utf8Content) {
  var t = gitHubTarget_();
  var apiBase = 'https://api.github.com/repos/' +
    encodeURIComponent(t.owner) + '/' + encodeURIComponent(t.repo) + '/contents/' + relativePath;

  var headers = {
    Authorization: 'Bearer ' + t.pat,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'treasury-cache-publisher'
  };

  // GET existing sha (404 = new file, no sha)
  var getResp = UrlFetchApp.fetch(apiBase + '?ref=' + encodeURIComponent(t.branch), {
    method: 'get',
    headers: headers,
    muteHttpExceptions: true
  });
  var getCode = getResp.getResponseCode();
  var sha = null;
  if (getCode === 200) {
    try { sha = JSON.parse(getResp.getContentText()).sha || null; }
    catch (e) { sha = null; }
  } else if (getCode !== 404) {
    return {
      ok: false,
      sha: null,
      message: 'GitHub GET failed: HTTP ' + getCode + ' ' + getResp.getContentText().slice(0, 400)
    };
  }

  var payload = {
    message: commitMessage,
    content: Utilities.base64Encode(utf8Content, Utilities.Charset.UTF_8),
    branch: t.branch
  };
  if (sha) payload.sha = sha;

  var putResp = UrlFetchApp.fetch(apiBase, {
    method: 'put',
    headers: headers,
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var putCode = putResp.getResponseCode();
  if (putCode >= 200 && putCode < 300) {
    var parsed = {};
    try { parsed = JSON.parse(putResp.getContentText()); } catch (e) {}
    return {
      ok: true,
      sha: parsed && parsed.content && parsed.content.sha ? parsed.content.sha : null,
      message: 'ok'
    };
  }
  return {
    ok: false,
    sha: null,
    message: 'GitHub PUT failed: HTTP ' + putCode + ' ' + putResp.getContentText().slice(0, 400)
  };
}

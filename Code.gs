/**
 * FX Timing Helper - Google Apps Script backend
 * --------------------------------------------------------------
 * Paste this WHOLE file into: Google Sheet > Extensions > Apps Script > Code.gs
 * Then run, in order: setup() -> testFetch() -> runPipeline() -> installTrigger()
 * Finally: Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 *
 * Data: Frankfurter (https://frankfurter.dev), free, no API key.
 * Decision support only. Not financial advice. Reference rates, not your bank's rate.
 */

// =============================================================
// 1. SETTINGS (safe to edit)
// =============================================================
const API = 'https://api.frankfurter.dev/v2/rates';   // primary (v2, ~220 currencies)
const API_V1 = 'https://api.frankfurter.dev/v1/';     // fallback (v1, ECB, ~31 currencies)
const LOOKBACK_DAYS = 1100;    // history pulled per run (~3 years)
const KEEP_CLEAN_DAYS = 400;   // rows per pair kept in clean_rates
const HISTORY_FOR_UI = 120;    // history points per pair returned by doGet()
const TRIGGER_HOUR = 18;       // daily run hour, in the script's time zone
const MIN_POINTS = 30;         // fewer clean points than this = pair skipped
const STALE_DAYS = 4;          // data older than this = low confidence (covers a weekend + 1 holiday)
const OUTLIER_K = 6;           // robust standard deviations for the spike rule
const DEFAULT_QUOTES = ['INR', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'MXN', 'PHP', 'SGD'];

// =============================================================
// 2. SHEET NAMES AND HEADERS (do not edit unless you know why)
// =============================================================
const SH = {
  config: 'config',
  raw: 'raw_rates',
  clean: 'clean_rates',
  decisions: 'decisions',
  log: 'quality_log'
};

const HEAD = {
  config: ['pair_id', 'base', 'quote', 'higher_is_better', 'deadline_days', 'active', 'fee_pct', 'target_rate'],
  raw: ['date', 'base', 'quote', 'rate', 'source', 'fetched_at'],
  clean: ['date', 'pair', 'base', 'quote', 'rate', 'is_outlier'],
  log: ['run_at', 'pair', 'rows_fetched', 'rows_new', 'duplicates', 'invalid', 'outliers',
        'latest_date', 'data_age_days', 'status', 'note'],
  decisions: [
    // identity
    'updated_at', 'pair', 'base', 'quote', 'higher_is_better', 'deadline_days', 'rate', 'rate_date',
    'data_age_days', 'points', 'outliers_flagged',
    // decision
    'score', 'decision', 'headline', 'convert_now_pct', 'confidence', 'reason',
    // indicator votes
    'signals_good', 'signals_total', 'signals_detail',
    // position
    'pct30', 'pct90', 'pct252', 'rank_1y', 'days_since_better', 'history_days', 'z30', 'z90',
    // levels
    'mean30', 'mean90', 'std30', 'min90', 'max90', 'range_pos90', 'vs_mean30_pct', 'vs_best90_pct',
    // trend
    'sma7', 'sma30', 'sma90', 'ema12', 'ema26', 'macd', 'macd_signal', 'macd_hist', 'momentum',
    // oscillators
    'rsi14', 'boll_pctB', 'boll_bandwidth',
    // trend strength
    'trend_slope30_pct_day', 'trend_r2_30', 'trend_slope90_pct_day', 'trend_r2_90',
    // volatility and moves
    'vol30_ann_pct', 'vol_ratio', 'avg_daily_move_pct', 'mom1_pct', 'mom7_pct', 'mom30_pct', 'exp_move7_pct',
    // behaviour
    'variance_ratio5', 'autocorr1', 'regime',
    // wait analysis
    'wait_horizon_obs', 'wait_p05_pct', 'wait_p50_pct', 'wait_p95_pct', 'wait_prob_better',
    // fees and target
    'fee_pct', 'fee_vs_weekly_move', 'target_rate', 'target_gap_pct', 'target_prob',
    // peer strength
    'base_strength_pct90', 'base_strong_count', 'base_peers', 'rel_mom30_vs_basket',
    // historical edge
    'edge_n', 'edge_bucket_mean7', 'edge_base_mean7', 'edge_bucket_win', 'edge_base_win'
  ]
};

// =============================================================
// 3. MENU + ONE-TIME SETUP
// =============================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('FX Helper')
    .addItem('1. Setup sheets', 'setup')
    .addItem('2. Test API fetch', 'testFetch')
    .addItem('3. Run pipeline now', 'runPipeline')
    .addItem('4. Install daily trigger', 'installTrigger')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const cfg = ensureSheet_(ss, SH.config, HEAD.config);
  if (cfg.getLastRow() < 2) {
    const rows = DEFAULT_QUOTES.map(q => ['USD/' + q, 'USD', q, true, 14, true, 0, '']);
    writeBlock_(cfg, 2, rows, []);
  }
  const raw = ensureSheet_(ss, SH.raw, HEAD.raw);
  const clean = ensureSheet_(ss, SH.clean, HEAD.clean);
  const dec = ensureSheet_(ss, SH.decisions, HEAD.decisions);
  clearBody_(dec);
  const log = ensureSheet_(ss, SH.log, HEAD.log);

  textCol_(raw, 1);
  textCol_(clean, 1);
  textCol_(dec, HEAD.decisions.indexOf('rate_date') + 1);
  textCol_(log, HEAD.log.indexOf('latest_date') + 1);

  // Remove the empty default tab if it is still there.
  ['Sheet1', 'Sheet 1'].forEach(name => {
    const s = ss.getSheetByName(name);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });
  Logger.log('Setup done. Tabs: ' + Object.keys(SH).map(k => SH[k]).join(', '));
}

function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runPipeline')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runPipeline').timeBased().everyDays(1).atHour(TRIGGER_HOUR).create();
  Logger.log('Daily trigger installed at hour ' + TRIGGER_HOUR + ' (' + Session.getScriptTimeZone() + ').');
}

function testFetch() {
  const pairs = readConfig_();
  if (!pairs.length) throw new Error('No active pairs in config. Run setup() first.');
  const p = pairs[0];
  const to = today_();
  const from = addDays_(to, -10);
  const res = fetchOne_(p.base, [p.quote], from, to);
  Logger.log('Pair %s | source %s | rows %s', p.id, res.source, res.rows.length);
  Logger.log(JSON.stringify(res.rows.slice(0, 5), null, 2));
}

// =============================================================
// 4. MAIN PIPELINE
// =============================================================
function runPipeline() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Another run is in progress. Skipping.'); return; }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const runIso = new Date().toISOString();
    const today = today_();
    const pairs = readConfig_(ss);
    if (!pairs.length) throw new Error('No active pairs in config. Run setup() first.');

    // Fetch + raw store
    const fetched = fetchAll_(pairs, addDays_(today, -LOOKBACK_DAYS), today);
    const raw = appendNewRaw_(ss.getSheetByName(SH.raw), fetched.rows, runIso);

    const byPair = {};
    raw.all.forEach(r => {
      const id = String(r[1]).toUpperCase() + '/' + String(r[2]).toUpperCase();
      (byPair[id] = byPair[id] || []).push({ date: r[0], rate: r[3] });
    });

    // Clean + stats per pair
    const results = [], logRows = [], cleanOut = [];
    pairs.forEach(p => {
      const fetchErr = fetched.errors[p.id] || '';
      const log = {
        run_at: runIso, pair: p.id, rows_fetched: fetched.counts[p.id] || 0, rows_new: raw.newCount[p.id] || 0,
        duplicates: 0, invalid: 0, outliers: 0, latest_date: '', data_age_days: '',
        status: 'OK', note: fetchErr
      };
      try {
        const rows = byPair[p.id] || [];
        if (!rows.length) throw new Error(fetchErr || 'No data for this pair');
        const c = cleanPair_(rows);
        log.duplicates = c.duplicates; log.invalid = c.invalid; log.outliers = c.outliers;
        const good = c.series.filter(s => !s.outlier);
        if (good.length) {
          log.latest_date = good[good.length - 1].date;
          log.data_age_days = daysBetween_(log.latest_date, today);
        }
        c.series.slice(-KEEP_CLEAN_DAYS).forEach(s => cleanOut.push([s.date, p.id, p.base, p.quote, s.rate, s.outlier]));

        const st = computeStats_(c.series, p, today);
        if (!st) {
          log.status = 'WARN';
          log.note = joinNote_(log.note, 'Only ' + good.length + ' clean points (need ' + MIN_POINTS + '); skipped');
        } else {
          st.outliers_flagged = c.outliers;
          results.push({ p: p, st: st });
          if (fetchErr) log.status = 'WARN';
          if (log.data_age_days > STALE_DAYS) {
            log.status = 'WARN';
            log.note = joinNote_(log.note, 'Data is ' + log.data_age_days + ' days old');
          }
        }
      } catch (e) {
        log.status = 'ERROR';
        log.note = String(e && e.message || e).slice(0, 300);
      }
      logRows.push(HEAD.log.map(h => cell_(log[h])));
    });

    addPeerStats_(results);
    const decisions = results.map(x => decide_(x.st, x.p, runIso));

    writeClean_(ss.getSheetByName(SH.clean), cleanOut);
    writeDecisions_(ss.getSheetByName(SH.decisions), decisions, pairs);
    appendLog_(ss.getSheetByName(SH.log), logRows);

    try {
      CacheService.getScriptCache().removeAll(['json_all'].concat(pairs.map(p => 'json_' + p.id)));
    } catch (e) { /* cache is optional */ }

    Logger.log('Run complete: %s pairs decided, %s new raw rows.', decisions.length, raw.added);
  } finally {
    lock.releaseLock();
  }
}

// =============================================================
// 5. CONFIG
// =============================================================
function readConfig_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH.config);
  if (!sh) return [];
  const seen = {};
  return readObjects_(sh)
    .filter(o => bool_(o.active, true) && o.base && o.quote)
    .map(o => {
      const base = String(o.base).trim().toUpperCase();
      const quote = String(o.quote).trim().toUpperCase();
      return {
        id: base + '/' + quote, base: base, quote: quote,
        higherIsBetter: bool_(o.higher_is_better, true),
        deadlineDays: num_(o.deadline_days, 0),
        feePct: num_(o.fee_pct, 0),
        targetRate: num_(o.target_rate, 0)
      };
    })
    .filter(p => {
      if (p.base === p.quote || seen[p.id]) return false;
      seen[p.id] = true;
      return true;
    });
}

// =============================================================
// 6. FETCH
// =============================================================
function fetchAll_(pairs, from, to) {
  const byBase = {};
  pairs.forEach(p => {
    byBase[p.base] = byBase[p.base] || [];
    if (byBase[p.base].indexOf(p.quote) < 0) byBase[p.base].push(p.quote);
  });
  const rows = [], errors = {}, counts = {};

  const take = (res) => res.rows.forEach(r => { r.source = res.source; rows.push(r); });
  const single = (base, q) => {
    try {
      const res = fetchOne_(base, [q], from, to);
      take(res);
    } catch (e) {
      errors[base + '/' + q] = String(e && e.message || e).slice(0, 300);
    }
    Utilities.sleep(300);
  };

  Object.keys(byBase).forEach(base => {
    const quotes = byBase[base];
    try {
      const res = fetchOne_(base, quotes, from, to);
      take(res);
      const got = {};
      res.rows.forEach(r => { got[r.quote] = true; });
      quotes.filter(q => !got[q]).forEach(q => single(base, q));   // retry missing ones alone
    } catch (e) {
      quotes.forEach(q => single(base, q));                          // one bad code can break a group
    }
  });

  rows.forEach(r => {
    const id = r.base + '/' + r.quote;
    counts[id] = (counts[id] || 0) + 1;
  });
  return { rows: rows, errors: errors, counts: counts };
}

function fetchOne_(base, quotes, from, to) {
  const url = API + '?base=' + encodeURIComponent(base) + '&quotes=' + encodeURIComponent(quotes.join(',')) +
              '&from=' + from + '&to=' + to;
  const r = httpGet_(url);
  if (r.ok) {
    const rows = parseRows_(r.text, base).filter(x => x.base === base && quotes.indexOf(x.quote) >= 0);
    if (rows.length) return { rows: rows, source: 'frankfurter-v2' };
  }
  // Fallback: v1 (ECB, fewer currencies)
  const url1 = API_V1 + from + '..' + to + '?base=' + encodeURIComponent(base) +
               '&symbols=' + encodeURIComponent(quotes.join(','));
  const r1 = httpGet_(url1);
  if (r1.ok) {
    const rows1 = parseRows_(r1.text, base).filter(x => x.base === base && quotes.indexOf(x.quote) >= 0);
    if (rows1.length) return { rows: rows1, source: 'frankfurter-v1' };
  }
  throw new Error('Fetch failed (v2 HTTP ' + r.code + ', v1 HTTP ' + r1.code + '): ' + String(r.text).slice(0, 150));
}

function httpGet_(url) {
  let last = { ok: false, code: 0, text: '' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { Accept: 'application/json' } });
      const code = resp.getResponseCode();
      last = { ok: code === 200, code: code, text: resp.getContentText() };
      if (code === 200) return last;
      if (code !== 429 && code !== 503 && code < 500) return last;   // 4xx: do not retry
    } catch (e) {
      last = { ok: false, code: 0, text: String(e && e.message || e) };
    }
    Utilities.sleep(2000 * (attempt + 1));
  }
  return last;
}

/** Accepts: JSON array of rows (v2), NDJSON, {rates:[...]}, v1 nested {rates:{date:{CUR:rate}}}. */
function parseRows_(text, base) {
  text = String(text || '').trim();
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text.split(/\r?\n/).map(l => {
      try { return JSON.parse(l); } catch (e2) { return null; }
    }).filter(Boolean);
  }
  const out = [];
  const push = (d, b, q, r) => {
    if (!d || !q) return;
    b = String(b || base).toUpperCase();
    q = String(q).toUpperCase();
    if (b === q) return;                       // v2 includes the base's own row (rate 1)
    out.push({ date: normDate_(d), base: b, quote: q, rate: Number(r) });
  };
  if (Array.isArray(data)) {
    data.forEach(o => { if (o) push(o.date, o.base, o.quote, o.rate); });
  } else if (data && Array.isArray(data.rates)) {
    data.rates.forEach(o => { if (o) push(o.date, o.base || data.base, o.quote, o.rate); });
  } else if (data && data.rates && typeof data.rates === 'object') {
    Object.keys(data.rates).forEach(k => {
      const v = data.rates[k];
      if (v && typeof v === 'object') Object.keys(v).forEach(q => push(k, data.base, q, v[q]));
      else push(data.date, data.base, k, v);
    });
  } else if (data && data.date && data.quote) {
    push(data.date, data.base, data.quote, data.rate);
  }
  return out;
}

// =============================================================
// 7. RAW STORE (append-only)
// =============================================================
function appendNewRaw_(sh, rows, runIso) {
  const existing = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.raw.length).getValues()
    : [];
  existing.forEach(r => { r[0] = normDate_(r[0]); });
  const keys = new Set(existing.map(r => r[0] + '|' + r[1] + '|' + r[2]));
  const add = [], newCount = {};
  rows.forEach(r => {
    if (!isFinite(r.rate) || r.rate <= 0) return;
    const k = r.date + '|' + r.base + '|' + r.quote;
    if (keys.has(k)) return;
    keys.add(k);
    add.push([r.date, r.base, r.quote, r.rate, r.source || 'frankfurter', runIso]);
    const id = r.base + '/' + r.quote;
    newCount[id] = (newCount[id] || 0) + 1;
  });
  if (add.length) writeBlock_(sh, sh.getLastRow() + 1, add, [1]);
  return { all: existing.concat(add), newCount: newCount, added: add.length };
}

// =============================================================
// 8. CLEAN
// =============================================================
function cleanPair_(rows) {
  let invalid = 0, duplicates = 0;
  const byDate = {};
  rows.forEach(r => {
    const d = normDate_(r.date);
    const rate = Number(r.rate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isFinite(rate) || rate <= 0) { invalid++; return; }
    // The API also publishes thin weekend prints. The statistics assume trading days
    // (252 per year, 5 per week), so Saturdays and Sundays are skipped. raw_rates keeps them.
    const wd = new Date(parseDay_(d)).getUTCDay();
    if (wd === 0 || wd === 6) return;
    if (byDate[d] !== undefined) duplicates++;
    byDate[d] = rate;                                  // later row wins
  });
  const series = Object.keys(byDate).sort().map(d => ({ date: d, rate: byDate[d], outlier: false }));

  // Spike rule: a point is an outlier when the jump INTO it and the jump OUT of it are both
  // extreme and in opposite directions. A genuine one-way step (e.g. devaluation) is kept.
  if (series.length > 20) {
    const ret = [];
    for (let i = 1; i < series.length; i++) ret.push(Math.log(series[i].rate / series[i - 1].rate));
    const med = median_(ret);
    const sigma = 1.4826 * median_(ret.map(x => Math.abs(x - med)));
    if (sigma > 0) {
      const lim = OUTLIER_K * sigma;
      for (let i = 1; i < series.length - 1; i++) {
        const a = ret[i - 1] - med, b = ret[i] - med;          // into i, out of i
        if (Math.abs(a) > lim && Math.abs(b) > lim && a * b < 0) series[i].outlier = true;
      }
      const lastIn = ret[ret.length - 1] - med;               // newest point has no "out" jump yet
      if (Math.abs(lastIn) > 2 * lim) series[series.length - 1].outlier = true;
    }
  }
  return { series: series, invalid: invalid, duplicates: duplicates,
           outliers: series.filter(s => s.outlier).length };
}

// =============================================================
// 9. STATISTICS
// =============================================================
function computeStats_(series, p, today) {
  const good = series.filter(s => !s.outlier);
  const n = good.length;
  if (n < MIN_POINTS) return null;

  const d = good.map(s => s.date);
  const r = good.map(s => s.rate);
  const dir = p.higherIsBetter ? 1 : -1;
  const last = r[n - 1];
  const tail = k => r.slice(Math.max(0, n - k));
  const favPct = k => { const w = tail(k); return w.filter(x => dir * x <= dir * last).length / w.length; };
  const rawPct = k => { const w = tail(k); return w.filter(x => x <= last).length / w.length; };

  // Position
  const w30 = tail(30), w90 = tail(90), w252 = tail(252);
  const mean30 = mean_(w30), mean90 = mean_(w90), std30 = std_(w30), std90 = std_(w90);
  const min90 = Math.min.apply(null, w90), max90 = Math.max.apply(null, w90);
  const pct30 = favPct(30), pct90 = favPct(90), pct252 = favPct(252);
  let better1y = 0;
  for (let i = Math.max(0, n - 252); i < n - 1; i++) if (dir * r[i] > dir * last) better1y++;
  let daysSinceBetter = null;
  for (let i = n - 2; i >= 0; i--) {
    if (dir * r[i] > dir * last) { daysSinceBetter = daysBetween_(d[i], d[n - 1]); break; }
  }
  const z30 = std30 > 0 ? (last - mean30) / std30 : 0;
  const z90 = std90 > 0 ? (last - mean90) / std90 : 0;
  const best90 = dir > 0 ? max90 : min90;

  // Trend
  const ema12 = emaSeries_(r, 12), ema26 = emaSeries_(r, 26);
  const macdS = r.map((_, i) => ema12[i] - ema26[i]);
  const sigS = emaSeries_(macdS, 9);
  const macd = macdS[n - 1], macdSig = sigS[n - 1], hist = macd - macdSig;
  const sma7 = mean_(tail(7)), sma30 = mean30, sma90 = mean90;

  // Oscillators
  const rsi = rsi_(r, 14);
  const w20 = tail(20), m20 = mean_(w20), s20 = std_(w20);
  const up = m20 + 2 * s20, lo = m20 - 2 * s20;
  const pctB = up > lo ? (last - lo) / (up - lo) : 0.5;
  const bandwidth = m20 ? (up - lo) / m20 : 0;

  // Trend strength
  const logs = r.map(Math.log);
  const lr30 = linreg_(logs.slice(-30)), lr90 = linreg_(logs.slice(-90));

  // Volatility
  const ret = [];
  for (let i = 1; i < n; i++) ret.push(logs[i] - logs[i - 1]);
  const ret30 = ret.slice(-30), ret90 = ret.slice(-90), ret252 = ret.slice(-252);
  const sd30 = std_(ret30), sd90 = std_(ret90);
  const vol30 = sd30 * Math.sqrt(252) * 100, vol90 = sd90 * Math.sqrt(252) * 100;
  const chg = k => n > k ? (last / r[n - 1 - k] - 1) * 100 : null;
  const exp7 = sd30 * Math.sqrt(5) * 100;   // one-sigma move over one week (5 trading days)

  // Behaviour
  const vr = varianceRatio_(ret252, 5);
  const ac = autocorr1_(ret252);
  const regime = vr == null ? 'unknown' : vr < 0.85 ? 'mean-reverting' : vr > 1.15 ? 'trending' : 'random-like';

  // Wait + target
  const h = p.deadlineDays > 0 ? clamp_(Math.round(p.deadlineDays * 5 / 7), 1, 60) : 10;
  const targetGap = p.targetRate > 0 ? dir * (p.targetRate / last - 1) * 100 : null;
  const ws = waitStats_(r, h, dir, targetGap);

  // Historical edge
  const edge = historicalEdge_(r, dir, pct90);

  // Votes
  const favBoll = clamp_(dir > 0 ? pctB : 1 - pctB, 0, 1);
  const favZ90 = dir * z90;
  const favRsi = rsi == null ? 50 : (dir > 0 ? rsi : 100 - rsi);
  const vsMean30 = dir * (last / mean30 - 1) * 100;
  const votes = [
    ['90-day percentile', pct90 >= 0.6],
    ['1-year percentile', pct252 >= 0.6],
    ['Bollinger position', favBoll >= 0.6],
    ['z-score vs 90 days', favZ90 >= 0.5],
    ['RSI', favRsi >= 55],
    ['Above 30-day average', vsMean30 > 0],
    ['7-day vs 30-day trend', dir * (sma7 - sma30) > 0]
  ];

  const feeRatio = p.feePct > 0 && exp7 > 0 ? p.feePct / exp7 : null;

  return {
    // internal (not written, used by decide_ / peers)
    _dir: dir, _favPct90: pct90, _favPct252: pct252, _favBoll: favBoll, _favZ90: favZ90, _favRsi: favRsi,
    _rawPct90: rawPct(90), _mom30raw: chg(30), _n252: w252.length,

    pair: p.id, base: p.base, quote: p.quote,
    higher_is_better: p.higherIsBetter, deadline_days: p.deadlineDays || '',
    rate: last, rate_date: d[n - 1], data_age_days: daysBetween_(d[n - 1], today), points: n,

    signals_good: votes.filter(v => v[1]).length, signals_total: votes.length,
    signals_detail: votes.map(v => v[0] + '=' + (v[1] ? 1 : 0)).join(';'),

    pct30: round_(pct30, 3), pct90: round_(pct90, 3), pct252: round_(pct252, 3),
    rank_1y: better1y + 1, days_since_better: daysSinceBetter,
    history_days: daysBetween_(d[0], d[n - 1]),
    z30: round_(z30, 2), z90: round_(z90, 2),

    mean30: round_(mean30, 6), mean90: round_(mean90, 6), std30: round_(std30, 6),
    min90: min90, max90: max90,
    range_pos90: max90 > min90 ? round_((last - min90) / (max90 - min90), 3) : 0.5,
    vs_mean30_pct: round_(vsMean30, 2),
    vs_best90_pct: round_(dir * (last / best90 - 1) * 100, 2),

    sma7: round_(sma7, 6), sma30: round_(sma30, 6), sma90: round_(sma90, 6),
    ema12: round_(ema12[n - 1], 6), ema26: round_(ema26[n - 1], 6),
    macd: round_(macd, 6), macd_signal: round_(macdSig, 6), macd_hist: round_(hist, 6),
    momentum: dir * hist > 0 ? 'favorable' : 'unfavorable',

    rsi14: round_(rsi, 1), boll_pctB: round_(pctB, 3), boll_bandwidth: round_(bandwidth, 4),

    trend_slope30_pct_day: lr30 ? round_(dir * lr30.slope * 100, 4) : null,
    trend_r2_30: lr30 ? round_(lr30.r2, 3) : null,
    trend_slope90_pct_day: lr90 ? round_(dir * lr90.slope * 100, 4) : null,
    trend_r2_90: lr90 ? round_(lr90.r2, 3) : null,

    vol30_ann_pct: round_(vol30, 2), vol_ratio: vol90 > 0 ? round_(vol30 / vol90, 2) : null,
    avg_daily_move_pct: round_(mean_(ret30.map(Math.abs)) * 100, 3),
    mom1_pct: round_(chg(1), 3), mom7_pct: round_(chg(7), 3), mom30_pct: round_(chg(30), 3),
    exp_move7_pct: round_(exp7, 2),

    variance_ratio5: round_(vr, 3), autocorr1: round_(ac, 3), regime: regime,

    wait_horizon_obs: h,
    wait_p05_pct: round_(ws.p05, 2), wait_p50_pct: round_(ws.p50, 2), wait_p95_pct: round_(ws.p95, 2),
    wait_prob_better: round_(ws.prob, 3),

    fee_pct: p.feePct || '', fee_vs_weekly_move: round_(feeRatio, 2),
    target_rate: p.targetRate || '', target_gap_pct: round_(targetGap, 2), target_prob: round_(ws.targetProb, 3),

    base_strength_pct90: null, base_strong_count: null, base_peers: null, rel_mom30_vs_basket: null,

    edge_n: edge.n, edge_bucket_mean7: round_(edge.bucketMean, 3), edge_base_mean7: round_(edge.baseMean, 3),
    edge_bucket_win: round_(edge.bucketWin, 3), edge_base_win: round_(edge.baseWin, 3)
  };
}

function waitStats_(r, h, dir, gap) {
  const chg = [], best = [];
  for (let i = 0; i + h < r.length; i++) {
    chg.push(dir * (r[i + h] / r[i] - 1) * 100);
    if (gap != null && gap > 0) {
      let b = -Infinity;
      for (let j = 1; j <= h; j++) b = Math.max(b, dir * (r[i + j] / r[i] - 1) * 100);
      best.push(b);
    }
  }
  const targetProb = gap == null ? null : gap <= 0 ? 1 : (best.length ? best.filter(b => b >= gap).length / best.length : null);
  if (chg.length < 20) return { obs: chg.length, p05: null, p50: null, p95: null, prob: null, targetProb: targetProb };
  return {
    obs: chg.length,
    p05: quantile_(chg, 0.05), p50: quantile_(chg, 0.5), p95: quantile_(chg, 0.95),
    prob: chg.filter(x => x > 0).length / chg.length,
    targetProb: targetProb
  };
}

function historicalEdge_(r, dir, pctNow) {
  const all = [], bucket = [];
  for (let i = 89; i + 7 < r.length; i++) {
    const v = dir * r[i];
    let c = 0;
    for (let j = i - 89; j <= i; j++) if (dir * r[j] <= v) c++;
    const f = dir * (r[i + 7] / r[i] - 1) * 100;
    all.push(f);
    if (Math.abs(c / 90 - pctNow) <= 0.10) bucket.push(f);
  }
  const win = a => a.filter(x => x > 0).length / a.length;
  const ok = bucket.length >= 30;
  return {
    n: bucket.length,
    bucketMean: ok ? mean_(bucket) : null, baseMean: all.length ? mean_(all) : null,
    bucketWin: ok ? win(bucket) : null, baseWin: all.length ? win(all) : null
  };
}

function addPeerStats_(results) {
  const groups = {};
  results.forEach(x => { (groups[x.p.base] = groups[x.p.base] || []).push(x); });
  Object.keys(groups).forEach(base => {
    const g = groups[base];
    if (g.length < 3) return;
    const strength = mean_(g.map(x => x.st._rawPct90));
    const strong = g.filter(x => x.st._rawPct90 >= 0.8).length;
    g.forEach(x => {
      const others = g.filter(y => y !== x && y.st._mom30raw != null).map(y => y.st._mom30raw);
      x.st.base_strength_pct90 = round_(strength, 3);
      x.st.base_strong_count = strong;
      x.st.base_peers = g.length;
      x.st.rel_mom30_vs_basket = (x.st._mom30raw != null && others.length)
        ? round_(x.st._mom30raw - mean_(others), 2) : null;
    });
  });
}

// =============================================================
// 10. DECISION ENGINE
// =============================================================
function decide_(st, p, runIso) {
  const score = Math.round(100 * (
    0.40 * st._favPct90 +
    0.25 * st._favPct252 +
    0.20 * st._favBoll +
    0.15 * clamp_((st._favZ90 + 2) / 4, 0, 1)));

  const dl = p.deadlineDays;
  let pct, label, override = '';
  if (st.target_gap_pct != null && st.target_gap_pct <= 0) {
    pct = 100; label = 'CONVERT NOW'; override = 'Your target rate has been reached.';
  } else if (dl > 0 && dl <= 2) {
    pct = 100; label = 'CONVERT NOW'; override = 'Your deadline is within 2 days.';
  } else if (score >= 75) {
    pct = 100; label = 'CONVERT NOW';
  } else if (score >= 60) {
    if (st.momentum === 'favorable') { pct = 50; label = 'CONVERT HALF NOW'; }
    else { pct = 75; label = 'CONVERT MOST NOW (75%)'; }
  } else if (score >= 40) {
    pct = 33; label = 'SPLIT: CONVERT 1/3 NOW';
  } else if (dl > 0 && dl <= 7) {
    pct = 33; label = 'SPLIT: CONVERT 1/3 NOW'; override = 'Your deadline is within 7 days, so waiting fully is risky.';
  } else {
    pct = 0; label = 'WAIT';
  }

  let confidence = 'high';
  if (st.points < 120 || st.data_age_days > STALE_DAYS) confidence = 'low';
  else if ((st.vol_ratio || 0) > 1.5 || st.outliers_flagged > 3 || st.points < 250) confidence = 'medium';

  const dsb = st.days_since_better;
  const tail = dsb == null ? 'best rate in the available history'
    : dsb >= 30 ? 'best rate in ' + humanDays_(dsb)
    : 'a better rate was seen ' + humanDays_(dsb) + ' ago';

  const P = x => Math.round(x * 100) + '%';
  const s = [];
  s.push('Level score ' + score + '/100: better for you than ' + P(st._favPct90) + ' of the last 90 days and ' +
         P(st._favPct252) + ' of the last year (rank ' + st.rank_1y + ' of ' + st._n252 + ').');
  s.push(Math.abs(st.vs_mean30_pct).toFixed(2) + '% ' + (st.vs_mean30_pct >= 0 ? 'better' : 'worse') +
         ' than the 30-day average.');
  s.push(st.signals_good + ' of ' + st.signals_total + ' indicators say today\'s level is good for you.');
  s.push(st.momentum === 'favorable' ? 'Momentum is favorable (the rate is moving your way).'
                                     : 'Momentum is unfavorable (the rate is moving against you).');
  if (st._favRsi >= 70) s.push('RSI shows the rate is stretched in your favor; runs like this often pause.');
  if (st._favRsi <= 30) s.push('RSI shows the rate is stretched against you; a bounce is possible but not guaranteed.');
  if (st.wait_prob_better != null) {
    s.push('If you wait ' + st.wait_horizon_obs + (st.wait_horizon_obs === 1 ? ' trading day' : ' trading days') + ', history says the rate ended better for you ' +
           P(st.wait_prob_better) + ' of the time; a bad case is ' + sgn_(st.wait_p05_pct) + '% and a good case is ' +
           sgn_(st.wait_p95_pct) + '%.');
  }
  if (st.regime === 'mean-reverting') s.push('This pair has tended to snap back toward its average.');
  if (st.regime === 'trending') s.push('This pair has tended to keep moving in the same direction for a while.');
  if (st.regime === 'random-like') s.push('This pair has behaved close to a random walk, so timing gains are uncertain.');
  if (st.base_peers) {
    s.push(st.base + ' is near its 90-day high against ' + st.base_strong_count + ' of ' + st.base_peers +
           ' tracked currencies.');
    if (st.rel_mom30_vs_basket != null && Math.abs(st.rel_mom30_vs_basket) >= 1.5) {
      s.push('Over 30 days this pair moved ' + sgn_(st.rel_mom30_vs_basket) + ' points vs. the basket, so the move is specific to ' +
             st.quote + '.');
    }
  }
  if ((st.vol_ratio || 0) > 1.5) s.push('Volatility is elevated (' + st.vol_ratio + 'x its 90-day level); moves may be larger than usual.');
  s.push('A typical one-week move is about +/-' + st.exp_move7_pct + '%.');
  if (st.fee_vs_weekly_move != null) {
    s.push(st.fee_vs_weekly_move >= 1
      ? 'Your provider cost (' + st.fee_pct + '%) is ' + st.fee_vs_weekly_move + 'x a typical weekly move, so comparing providers may save more than timing.'
      : 'Your provider cost (' + st.fee_pct + '%) is smaller than a typical weekly move.');
  }
  if (st.target_rate) {
    s.push(st.target_gap_pct <= 0 ? 'Target ' + st.target_rate + ' is reached.'
      : 'Target ' + st.target_rate + ' needs ' + st.target_gap_pct + '% more; historically reached within the horizon ' +
        (st.target_prob == null ? 'n/a' : P(st.target_prob)) + ' of the time.');
  }
  if (st.edge_bucket_mean7 != null && st.edge_base_mean7 != null) {
    const diff = st.edge_bucket_mean7 - st.edge_base_mean7;
    let msg = 'On ' + st.edge_n + ' past days at a similar level, the next week moved ' + sgn_(st.edge_bucket_mean7, 2) +
              '% for you on average vs. ' + sgn_(st.edge_base_mean7, 2) + '% on all days';
    if (st._favPct90 >= 0.6 && diff < -0.05) msg += ', so good levels like this have tended to fade (supports converting now).';
    else if (st._favPct90 <= 0.4 && diff > 0.05) msg += ', so weak levels like this have tended to recover (supports waiting).';
    else msg += ', so the level alone gave no clear edge; splitting is a sensible hedge.';
    s.push(msg);
  }
  if (override) s.push('Override: ' + override);

  const out = {};
  Object.keys(st).forEach(k => { if (k.charAt(0) !== '_') out[k] = st[k]; });
  out.updated_at = runIso;
  out.score = score;
  out.decision = label;
  out.headline = label + ' - ' + tail;
  out.convert_now_pct = pct;
  out.confidence = confidence;
  out.reason = s.join(' ');
  return out;
}

// =============================================================
// 11. OUTPUT
// =============================================================
function writeClean_(sh, rows) {
  clearBody_(sh);
  writeBlock_(sh, 2, rows.map(r => r.map(cell_)), [1]);
  trimRows_(sh, rows.length + 1);
}

function writeDecisions_(sh, decisions, pairs) {
  const active = {};
  pairs.forEach(p => { active[p.id] = true; });
  const map = {};
  readObjects_(sh).forEach(o => { if (active[o.pair]) map[o.pair] = o; });   // keep yesterday's row for failed pairs
  decisions.forEach(o => { map[o.pair] = o; });
  const score = o => { const v = Number(o.score); return isFinite(v) && o.score !== '' ? v : -1; };
  const rows = Object.keys(map).map(k => map[k]).sort((a, b) => score(b) - score(a));
  clearBody_(sh);
  writeBlock_(sh, 2, rows.map(o => HEAD.decisions.map(h => cell_(o[h]))), [HEAD.decisions.indexOf('rate_date') + 1]);
  trimRows_(sh, rows.length + 1);
}

function appendLog_(sh, rows) {
  writeBlock_(sh, sh.getLastRow() + 1, rows, [HEAD.log.indexOf('latest_date') + 1]);
}

// =============================================================
// 12. JSON API  (Deploy > Web app)
//   GET <url>                -> all pairs
//   GET <url>?pair=USD/INR   -> one pair
//   GET <url>?callback=fn    -> JSONP (fallback if the browser blocks CORS)
// =============================================================
function doGet(e) {
  const params = (e && e.parameter) || {};
  const want = params.pair ? String(params.pair).toUpperCase() : '';
  const key = 'json_' + (want || 'all');
  let body = null;
  try { body = CacheService.getScriptCache().get(key); } catch (err) { /* optional */ }
  if (!body) {
    body = JSON.stringify(buildPayload_(want));
    try { if (body.length < 95000) CacheService.getScriptCache().put(key, body, 600); } catch (err) { /* optional */ }
  }
  if (params.callback && /^[A-Za-z_$][\w$.]*$/.test(params.callback)) {
    return ContentService.createTextOutput(params.callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function buildPayload_(want) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let pairs = readObjects_(ss.getSheetByName(SH.decisions));
  if (want) pairs = pairs.filter(o => o.pair === want);

  const hist = {};
  const csh = ss.getSheetByName(SH.clean);
  const clean = csh.getLastRow() > 1 ? csh.getRange(2, 1, csh.getLastRow() - 1, HEAD.clean.length).getValues() : [];
  clean.forEach(row => {
    const id = row[1];
    if (want && id !== want) return;
    (hist[id] = hist[id] || []).push({
      date: normDate_(row[0]), rate: Number(row[4]),
      outlier: row[5] === true || String(row[5]).toUpperCase() === 'TRUE'
    });
  });

  pairs.forEach(o => {
    Object.keys(o).forEach(k => {
      if (o[k] instanceof Date) o[k] = o[k].toISOString();
      if (o[k] === '') o[k] = null;
    });
    o.rate_date = normDate_(o.rate_date);
    o.history = (hist[o.pair] || []).slice(-HISTORY_FOR_UI);
  });

  return {
    generated_at: new Date().toISOString(),
    source: 'Frankfurter reference rates (frankfurter.dev)',
    disclaimer: 'Decision support only, not financial advice. Reference rates, not your bank or provider rate.',
    pairs: pairs
  };
}

// =============================================================
// 13. SHEET HELPERS
// =============================================================
function ensureSheet_(ss, name, header) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  const cols = sh.getMaxColumns();
  if (cols < header.length) sh.insertColumnsAfter(cols, header.length - cols);
  if (cols > header.length) sh.deleteColumns(header.length + 1, cols - header.length);   // save cells
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function textCol_(sh, col) {
  sh.getRange(1, col, sh.getMaxRows(), 1).setNumberFormat('@');
}

function writeBlock_(sh, startRow, values, textCols) {
  if (!values.length) return;
  const need = startRow + values.length - 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  (textCols || []).forEach(c => { if (c > 0) sh.getRange(startRow, c, values.length, 1).setNumberFormat('@'); });
  sh.getRange(startRow, 1, values.length, values[0].length).setValues(values);
}

function clearBody_(sh) {
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).clearContent();
}

function trimRows_(sh, keep) {
  const max = sh.getMaxRows(), spare = 50;
  if (max > keep + spare) sh.deleteRows(keep + spare + 1, max - keep - spare);
}

function readObjects_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues();
  const head = v[0].map(String);
  return v.slice(1).filter(r => r.some(c => c !== '' && c !== null)).map(r => {
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = r[i]; });
    return o;
  });
}

// =============================================================
// 14. MATH + FORMAT HELPERS
// =============================================================
function mean_(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function variance_(a) {
  if (a.length < 2) return 0;
  const m = mean_(a);
  return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
}
function std_(a) { return Math.sqrt(variance_(a)); }
function quantile_(a, q) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function median_(a) { return quantile_(a, 0.5); }
function clamp_(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function round_(x, dp) {
  if (x == null || typeof x !== 'number' || !isFinite(x)) return null;
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}
function emaSeries_(x, period) {
  const k = 2 / (period + 1), out = [x[0]];
  for (let i = 1; i < x.length; i++) out.push(x[i] * k + out[i - 1] * (1 - k));
  return out;
}
function rsi_(x, period) {
  if (x.length <= period) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const ch = x[i] - x[i - 1];
    if (ch > 0) g += ch; else l -= ch;
  }
  g /= period; l /= period;
  for (let i = period + 1; i < x.length; i++) {
    const ch = x[i] - x[i - 1];
    g = (g * (period - 1) + Math.max(ch, 0)) / period;
    l = (l * (period - 1) + Math.max(-ch, 0)) / period;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}
function linreg_(y) {
  const m = y.length;
  if (m < 3) return null;
  const xm = (m - 1) / 2, ym = mean_(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < m; i++) {
    sxy += (i - xm) * (y[i] - ym); sxx += (i - xm) * (i - xm); syy += (y[i] - ym) * (y[i] - ym);
  }
  const slope = sxx ? sxy / sxx : 0;
  return { slope: slope, r2: syy && sxx ? (sxy * sxy) / (sxx * syy) : 0 };
}
function varianceRatio_(ret, q) {
  if (ret.length < q * 4) return null;
  const v1 = variance_(ret);
  if (!v1) return null;
  const sums = [];
  for (let i = 0; i + q <= ret.length; i++) {
    let s = 0;
    for (let j = i; j < i + q; j++) s += ret[j];
    sums.push(s);
  }
  return variance_(sums) / (q * v1);
}
function autocorr1_(x) {
  if (x.length < 3) return null;
  const m = mean_(x);
  let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) {
    den += (x[i] - m) * (x[i] - m);
    if (i > 0) num += (x[i] - m) * (x[i - 1] - m);
  }
  return den ? num / den : null;
}
function normDate_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  const s = String(d == null ? '' : d).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}
function parseDay_(s) {
  const p = String(s).split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
}
function daysBetween_(a, b) { return Math.round((parseDay_(b) - parseDay_(a)) / 86400000); }
function today_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function addDays_(day, n) {
  return Utilities.formatDate(new Date(parseDay_(day) + n * 86400000), 'UTC', 'yyyy-MM-dd');
}
function humanDays_(d) {
  if (d === 1) return '1 day';
  if (d < 60) return d + ' days';
  if (d < 730) return Math.round(d / 30.4) + ' months';
  return Math.round(d / 365) + ' years';
}
function sgn_(x, dp) {
  if (x == null || !isFinite(x)) return 'n/a';
  return (x >= 0 ? '+' : '') + Number(x).toFixed(dp == null ? 1 : dp);
}
function bool_(v, def) {
  if (v === true || v === false) return v;
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return def;
  return ['TRUE', 'YES', 'Y', '1'].indexOf(s) >= 0;
}
function num_(v, def) {
  if (v === '' || v == null) return def;
  const x = Number(v);
  return isFinite(x) ? x : def;
}
function cell_(v) {
  if (v == null) return '';
  if (typeof v === 'number' && !isFinite(v)) return '';
  return v;
}
function joinNote_(a, b) { return a ? a + ' | ' + b : b; }

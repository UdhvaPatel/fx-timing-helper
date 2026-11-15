/* =========================================================
   FX Timing Helper - UI
   ---------------------------------------------------------
   Any From -> To pair is analysed live in the browser:
     Frankfurter API (3 years, daily) -> engine.js (clean, statistics, decision) -> this UI.
   Your Google Sheet pipeline feeds the "watchlist" section (daily snapshot of tracked pairs).

   API_URL = your Apps Script web-app URL (ends in /exec). Leave '' to hide the watchlist.
   URL options: ?from=CAD&to=INR  ?nointro
   ========================================================= */

const API_URL = 'https://script.google.com/macros/s/AKfycbyVUKGyBR-_Mv4790DVvY97YFDBES6Bc2dbKXKCUFpV3CAOMIie1yxL2OotsiWq5hMe0A/exec';

const FX_API = 'https://api.frankfurter.dev/v2';
const LOOKBACK_DAYS = 1100;
const BASKET_DAYS = 150;
const MAJORS = ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'CAD', 'AUD', 'CHF', 'CNY', 'SGD', 'AED', 'MXN'];
const FALLBACK_CCY = {
  USD: ['US Dollar', '$'], EUR: ['Euro', '€'], GBP: ['British Pound', '£'], JPY: ['Japanese Yen', '¥'],
  INR: ['Indian Rupee', '₹'], CAD: ['Canadian Dollar', '$'], AUD: ['Australian Dollar', '$'], CHF: ['Swiss Franc', 'Fr'],
  CNY: ['Chinese Yuan', '¥'], SGD: ['Singapore Dollar', '$'], AED: ['UAE Dirham', 'د.إ'], MXN: ['Mexican Peso', '$'],
  NZD: ['New Zealand Dollar', '$'], HKD: ['Hong Kong Dollar', '$'], SEK: ['Swedish Krona', 'kr'], NOK: ['Norwegian Krone', 'kr'],
  DKK: ['Danish Krone', 'kr'], PLN: ['Polish Zloty', 'zł'], ZAR: ['South African Rand', 'R'], BRL: ['Brazilian Real', 'R$'],
  KRW: ['South Korean Won', '₩'], THB: ['Thai Baht', '฿'], PHP: ['Philippine Peso', '₱'], IDR: ['Indonesian Rupiah', 'Rp'],
  MYR: ['Malaysian Ringgit', 'RM'], TRY: ['Turkish Lira', '₺'], SAR: ['Saudi Riyal', '﷼'], ILS: ['Israeli Shekel', '₪'],
  CZK: ['Czech Koruna', 'Kč'], HUF: ['Hungarian Forint', 'Ft']
};

const E = window.FXEngine;
const params = new URLSearchParams(location.search);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
const TODAY = new Date().toISOString().slice(0, 10);

const state = {
  from: 'USD', to: 'INR', amount: 1000,
  plan: { deadline: 14, fee: 0, target: 0 },
  range: '6M', mode: 'plain',
  ccy: new Map(), rows: null, clean: null, result: null, error: null, token: 0,
  basket: null, basketState: 'loading', sheet: [], sheetState: API_URL ? 'loading' : 'off'
};
const seriesCache = new Map();
const basketCache = new Map();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !isFinite(Number(v))) ? null : Number(v);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
};
const addDays = (day, n) => new Date(E.util.parseDay(day) + n * 864e5).toISOString().slice(0, 10);

// =========================================================
// Icons
// =========================================================
const sv = (d, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${d}</svg>`;
const ICON = {
  check: sv('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cross: sv('<path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/>'),
  arrow: sv('<path d="M5 12h14M13 6l6 6-6 6"/>', 'arr'),
  down: sv('<path d="M12 5v14M6 13l6 6 6-6"/>', 'arr'),
  search: sv('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  up: '▲', dn: '▼'
};

// =========================================================
// Formatting
// =========================================================
function rateDp(v) {
  const a = Math.abs(v);
  if (!(a > 0)) return 4;
  if (a >= 100) return 2;
  if (a >= 10) return 3;
  if (a >= 1) return 4;
  return Math.min(10, Math.ceil(-Math.log10(a)) + 3);
}
function fmtRate(v, dp) {
  if (v == null || !isFinite(v)) return '—';
  dp = dp == null ? rateDp(v) : dp;
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtMoney(v, cur) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 1000 ? 0 : a >= 1 ? 2 : Math.min(8, Math.ceil(-Math.log10(a || 1)) + 2);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v);
  } catch (e) {
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + ' ' + cur;
  }
}
function fmtPct(v, dp = 1, signed = true) {
  if (v == null || !isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(dp);
  const zero = Number(s) === 0;
  return (zero ? '' : v > 0 ? (signed ? '+' : '') : '−') + s + '%';
}
const fmtFrac = v => v == null || !isFinite(v) ? '—' : Math.round(v * 100) + '%';
function fmtDate(d, withYear) {
  if (!d) return '—';
  const p = String(d).slice(0, 10).split('-').map(Number);
  if (p.length < 3 || p.some(isNaN)) return String(d);
  const o = withYear === 'my' ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' };
  if (withYear === true) o.year = 'numeric';
  o.timeZone = 'UTC';
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-GB', o);
}
function formatValue(v, ds) {
  switch (ds.fmt) {
    case 'rate': return fmtRate(v);
    case 'money': return fmtMoney(v, ds.cur);
    case 'int': return Math.round(v).toLocaleString('en-US');
    case 'frac': return fmtFrac(v);
    default: return String(Math.round(v));
  }
}
const countAttr = (v, fmt, extra = '') => `data-count="${v}" data-fmt="${fmt}" ${extra}`;
const ccyName = c => (state.ccy.get(c) || {}).name || c;
function ccySym(c) {
  const s = (state.ccy.get(c) || {}).symbol;
  return s && s.length <= 3 && s !== c ? s : c.slice(0, 1);
}

// =========================================================
// Data
// =========================================================
async function getJSON(url, ms = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      let m = 'The rates service answered with an error (HTTP ' + r.status + ')';
      try { const j = await r.json(); if (j && j.message) m = j.message.charAt(0).toUpperCase() + j.message.slice(1); } catch (e) { /* not JSON */ }
      const err = new Error(m); err.status = r.status; throw err;
    }
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The rates service took too long to respond');
    if (e instanceof TypeError) throw new Error('Could not reach the rates service. Check your connection');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
async function getJSONRetry(url) {
  try { return await getJSON(url); }
  catch (e) {
    if (e.status === 503 || e.status === 429) { await new Promise(r => setTimeout(r, 1500)); return getJSON(url); }
    throw e;
  }
}

async function loadCurrencies() {
  Object.keys(FALLBACK_CCY).forEach(c => state.ccy.set(c, { code: c, name: FALLBACK_CCY[c][0], symbol: FALLBACK_CCY[c][1] }));
  let list = null;
  try {
    const cached = JSON.parse(store.get('fx_ccy') || 'null');
    if (cached && Date.now() - cached.t < 864e5 && Array.isArray(cached.list) && cached.list.length > 20) list = cached.list;
  } catch (e) { /* ignore */ }
  if (!list) {
    try {
      const raw = await getJSON(FX_API + '/currencies', 10000);
      list = raw.filter(c => c && /^[A-Z]{3}$/.test(c.iso_code || '') && (c.type === 'currency' || c.type === 'metal'))
        .map(c => ({ code: c.iso_code, name: c.name || c.iso_code, symbol: c.symbol || '' }));
      if (list.length > 20) store.set('fx_ccy', JSON.stringify({ t: Date.now(), list }));
    } catch (e) { list = null; }
  }
  if (list && list.length > 20) {
    state.ccy = new Map(list.sort((a, b) => a.code.localeCompare(b.code)).map(c => [c.code, c]));
  }
}

async function getSeries(from, to) {
  const key = from + '/' + to;
  if (seriesCache.has(key)) return seriesCache.get(key);
  const inv = seriesCache.get(to + '/' + from);
  if (inv) {
    const rows = inv.map(r => ({ date: r.date, rate: 1 / r.rate }));
    seriesCache.set(key, rows);
    return rows;
  }
  const url = `${FX_API}/rates?base=${encodeURIComponent(from)}&quotes=${encodeURIComponent(to)}&from=${addDays(TODAY, -LOOKBACK_DAYS)}`;
  const data = await getJSONRetry(url);
  if (!Array.isArray(data)) throw new Error('Unexpected answer from the rates service');
  const rows = data.filter(r => r && String(r.quote).toUpperCase() === to && String(r.base).toUpperCase() === from)
    .map(r => ({ date: String(r.date).slice(0, 10), rate: Number(r.rate) }));
  seriesCache.set(key, rows);
  return rows;
}

// A 9-day request answers in a fraction of the time of the 3-year one: show the rate first.
async function getQuick(from, to) {
  const data = await getJSON(`${FX_API}/rates?base=${encodeURIComponent(from)}&quotes=${encodeURIComponent(to)}&from=${addDays(TODAY, -9)}`, 8000);
  if (!Array.isArray(data)) return null;
  const sr = E.clean(data.filter(r => r && String(r.quote).toUpperCase() === to).map(r => ({ date: r.date, rate: r.rate }))).series;
  if (!sr.length) return null;
  const last = sr[sr.length - 1], prev = sr[sr.length - 2];
  return { rate: last.rate, date: last.date, chg: prev ? (last.rate / prev.rate - 1) * 100 : 0 };
}

async function getBasket(from) {
  if (basketCache.has(from)) return basketCache.get(from);
  const quotes = MAJORS.filter(c => c !== from);
  const data = await getJSONRetry(`${FX_API}/rates?base=${encodeURIComponent(from)}&quotes=${quotes.join(',')}&from=${addDays(TODAY, -BASKET_DAYS)}`);
  if (!Array.isArray(data)) throw new Error('Unexpected answer from the rates service');
  const by = {};
  data.forEach(r => { const q = String(r.quote).toUpperCase(); (by[q] = by[q] || []).push({ date: r.date, rate: Number(r.rate) }); });
  const items = quotes.map(q => {
    const s = E.clean(by[q] || []).series.filter(x => !x.outlier);
    if (s.length < 35) return null;
    const r = s.map(x => x.rate), n = r.length, last = r[n - 1];
    const w = r.slice(-90);
    return {
      code: q, rate: last, date: s[n - 1].date,
      chg1: (last / r[n - 2] - 1) * 100,
      mom30: (last / r[n - 31] - 1) * 100,
      pct90: w.filter(v => v <= last).length / w.length,
      spark: w.map(v => ({ rate: v }))
    };
  }).filter(Boolean);
  const out = { from, items };
  basketCache.set(from, out);
  return out;
}

function loadJsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = 'fx_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 20000);
    function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = d => { cleanup(); resolve(d); };
    s.onerror = () => { cleanup(); reject(new Error('failed')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}
async function loadSheet() {
  if (!API_URL) { state.sheetState = 'off'; return; }
  let d;
  try { d = await getJSON(API_URL, 20000); }
  catch (e1) { try { d = await loadJsonp(API_URL); } catch (e2) { state.sheetState = 'error'; return; } }
  if (!d || !Array.isArray(d.pairs)) { state.sheetState = 'error'; return; }
  state.sheet = d.pairs.map(o => {
    const hib = o.higher_is_better == null || o.higher_is_better === '' ? true : (o.higher_is_better === true || String(o.higher_is_better).toUpperCase() === 'TRUE');
    const base = String(o.base || '').toUpperCase(), quote = String(o.quote || '').toUpperCase();
    return {
      from: hib ? base : quote, to: hib ? quote : base, base, quote, hib,
      score: num(o.score), decision: String(o.decision || ''), rate: num(o.rate), rate_date: String(o.rate_date || '').slice(0, 10),
      updated_at: o.updated_at, deadline: num(o.deadline_days), fee: num(o.fee_pct), target: num(o.target_rate),
      history: (o.history || []).map(h => ({ rate: Number(h.rate), outlier: h.outlier === true })).filter(h => h.rate > 0)
    };
  }).filter(p => /^[A-Z]{3}$/.test(p.base) && /^[A-Z]{3}$/.test(p.quote));
  state.sheetState = 'ok';
}

// ---------- plan ----------
const planKey = () => `fx_plan_${state.from}_${state.to}`;
function loadPlan() {
  let p = null;
  try { p = JSON.parse(store.get(planKey()) || 'null'); } catch (e) { /* ignore */ }
  if (!p) {
    const tracked = state.sheet.find(s => s.from === state.from && s.to === state.to);
    if (tracked) {
      p = { deadline: tracked.deadline || 0, fee: tracked.fee || 0,
            target: tracked.target ? (tracked.hib ? tracked.target : 1 / tracked.target) : 0 };
    }
  }
  state.plan = {
    deadline: p && p.deadline >= 0 ? Number(p.deadline) || 0 : 14,
    fee: p && p.fee > 0 ? Number(p.fee) : 0,
    target: p && p.target > 0 ? Number(p.target) : 0
  };
}
const savePlan = () => store.set(planKey(), JSON.stringify(state.plan));

function analyse() {
  state.result = null; state.clean = null;
  if (!state.rows) return;
  const c = E.clean(state.rows);
  state.clean = c;
  const st = E.compute(c.series, {
    base: state.from, quote: state.to, higherIsBetter: true,
    deadlineDays: state.plan.deadline, feePct: state.plan.fee, targetRate: state.plan.target
  }, TODAY);
  if (!st) return;
  const b = state.basket;
  if (b && b.from === state.from && b.items.length >= 3) {
    const others = b.items.filter(i => i.code !== state.to);
    st.base_peers = b.items.length;
    st.base_strong_count = b.items.filter(i => i.pct90 >= 0.8).length;
    st.base_strength_pct90 = E.util.round(E.util.mean(b.items.map(i => i.pct90)), 3);
    st.rel_mom30_vs_basket = st._mom30raw != null && others.length ? E.util.round(st._mom30raw - E.util.mean(others.map(i => i.mom30)), 2) : null;
  }
  state.result = E.decide(st);
}

// =========================================================
// Motion helpers
// =========================================================
function animateNumber(el, to, from) {
  const ds = el.dataset;
  if (to == null || !isFinite(to)) { el.textContent = '—'; return; }
  const prev = from != null ? from : (ds.value != null && ds.value !== '' ? Number(ds.value) : null);
  ds.value = to;
  if (reduceMotion || prev == null || !isFinite(prev) || prev === to) { el.textContent = formatValue(to, ds); return; }
  const t0 = performance.now(), dur = Number(ds.dur || 1000);
  cancelAnimationFrame(el._raf);
  const step = now => {
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 4);
    el.textContent = formatValue(prev + (to - prev) * e, ds);
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}
function countUp(el, instant) {
  if (el.dataset.counted) return;
  el.dataset.counted = '1';
  const to = Number(el.dataset.count);
  if (instant) { el.dataset.value = to; el.textContent = isFinite(to) ? formatValue(to, el.dataset) : '—'; return; }
  animateNumber(el, to, el.dataset.fmt === 'money' ? to * 0.97 : 0);
}
function drawLine(p, dur) {
  if (reduceMotion || !p || !p.getTotalLength) return;
  dur = dur || 1000;
  const len = p.getTotalLength();
  if (!len) return;
  p.style.transition = 'none';
  p.style.strokeDasharray = len;
  p.style.strokeDashoffset = len;
  p.getBoundingClientRect();
  p.style.transition = `stroke-dashoffset ${dur}ms cubic-bezier(0.65,0,0.35,1)`;
  p.style.strokeDashoffset = '0';
  setTimeout(() => { p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; p.style.transition = ''; }, dur + 80);
}

const DIGITS = '0123456789'.split('').map(n => `<span>${n}</span>`).join('');
function setOdometer(el, str, animate) {
  const chars = Array.from(str);
  const sig = chars.map(c => /\d/.test(c) ? 'd' : c).join('');
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = chars.map(c => /\d/.test(c)
      ? `<span class="odo__d"><span class="odo__col">${DIGITS}</span></span>`
      : `<span class="odo__s">${esc(c)}</span>`).join('');
    el.offsetWidth; // start state must be committed before the roll
  }
  const digits = chars.filter(c => /\d/.test(c));
  $$('.odo__col', el).forEach((col, i) => {
    const on = animate && !reduceMotion;
    col.style.transition = on ? '' : 'none';
    col.style.transitionDelay = on ? (i * 55) + 'ms' : '0ms';
    col.style.transform = `translateY(${-Number(digits[i]) * 10}%)`;
  });
}

let io = null;
function initReveal(root = document, instant = false) {
  $$('[data-reveal-group]', root).forEach(g => Array.from(g.children).forEach((el, i) => {
    if (!el.hasAttribute('data-reveal')) el.setAttribute('data-reveal', '');
    el.style.setProperty('--i', Math.min(i, 10));
  }));
  const els = $$('[data-reveal]:not(.is-visible)', root);
  if (instant || !('IntersectionObserver' in window)) { els.forEach(el => revealEl(el, true)); return; }
  if (!io) {
    io = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      revealEl(e.target, false);
      io.unobserve(e.target);
    }), { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
  }
  els.forEach(el => io.observe(el));
}
function revealEl(el, instant) {
  el.classList.add('is-visible');
  if (instant) el.classList.add('is-done');
  else setTimeout(() => el.classList.add('is-done'), 1300 + (parseInt(el.style.getPropertyValue('--i'), 10) || 0) * 70);
  [el].concat($$('*', el)).forEach(x => {
    if (x.dataset.count != null) countUp(x, instant);
    if (x.dataset.dash != null) requestAnimationFrame(() => { x.style.strokeDashoffset = x.dataset.dash; });
    if (x.dataset.needle != null) requestAnimationFrame(() => { x.style.setProperty('--a', x.dataset.needle + 'deg'); });
    if (x.dataset.odo != null) setOdometer(x, x.dataset.odo, !instant);
    if (x.classList.contains('spark') && !x.dataset.drawn) { x.dataset.drawn = '1'; if (!instant) drawLine($('path.spark__line', x), 1100); }
    if (x.classList.contains('chart') && !x.classList.contains('is-drawn')) { x.classList.add('is-drawn'); if (!instant) drawLine($('path.line', x), 1500); }
  });
}
function withInstant(fn) {
  document.body.classList.add('instant');
  fn();
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('instant')));
}

function syncSegs(root = document) {
  $$('.segs', root).forEach(seg => {
    const on = $('[aria-pressed="true"],[aria-checked="true"]', seg);
    const thumb = $('.segs__thumb', seg);
    if (!on || !thumb) return;
    thumb.style.width = on.offsetWidth + 'px';
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
    seg.classList.add('is-ready');
  });
}

// =========================================================
// Sparklines + charts
// =========================================================
function buildSpark(el, hist) {
  const W = el.clientWidth, H = el.clientHeight;
  const pts = (hist || []).filter(x => !x.outlier).map(x => x.rate);
  if (!W || !H || pts.length < 2) { el.innerHTML = ''; return; }
  const pad = 4;
  const min = Math.min(...pts), max = Math.max(...pts), rng = (max - min) || 1;
  const X = i => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const Y = v => pad + (1 - (v - min) / rng) * (H - 2 * pad);
  const d = pts.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><path class="spark__line" d="${d}"/>
    <circle class="spark__end" cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(pts[pts.length - 1]).toFixed(1)}" r="2.6"/></svg>`;
}
function hydrateSparks(root = document) {
  $$('.spark[data-basket]', root).forEach(el => {
    const it = state.basket && state.basket.items.find(i => i.code === el.dataset.basket);
    if (it) buildSpark(el, it.spark);
  });
  $$('.spark[data-sheet]', root).forEach(el => {
    const p = state.sheet[Number(el.dataset.sheet)];
    if (p) buildSpark(el, p.hib ? p.history : p.history.map(h => ({ rate: 1 / h.rate, outlier: h.outlier })));
  });
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
}
const RANGES = { '3M': 63, '6M': 126, '1Y': 252, '3Y': 100000 };

function buildChart() {
  const box = $('#chart'), p = state.result;
  if (!box || !p || !state.clean) return;
  const W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return;
  const full = state.clean.series;
  const gi = full.map((_, i) => i).filter(i => !full[i].outlier);
  const gr = gi.map(i => full[i].rate);

  // rolling stats on the full clean history (so short ranges have no warm-up gap)
  const band = {}, sma = {};
  for (let k = 19; k < gr.length; k++) {
    const w = gr.slice(k - 19, k + 1), m = w.reduce((s, x) => s + x, 0) / 20;
    const sd = Math.sqrt(w.reduce((s, x) => s + (x - m) * (x - m), 0) / 19);
    band[gi[k]] = [m + 2 * sd, m - 2 * sd];
    if (k >= 29) sma[gi[k]] = gr.slice(k - 29, k + 1).reduce((s, x) => s + x, 0) / 30;
  }

  const start = Math.max(0, full.length - (RANGES[state.range] || 126));
  const idx = gi.filter(i => i >= start);
  if (idx.length < 5) { box.innerHTML = '<p class="muted">Not enough history to draw this range.</p>'; return; }
  const rates = idx.map(i => full[i].rate);
  const lastI = idx[idx.length - 1], last = rates[rates.length - 1];
  const hasCone = p.wait_p05_pct != null && p.wait_p95_pct != null;
  const h = hasCone ? p.wait_horizon_obs : 0;
  const span = lastI - start;
  const fut = hasCone ? Math.max(h, Math.round(span * 0.06)) : 0;   // keep the cone readable on long ranges
  const padL = 2, padR = W < 520 ? 54 : 70, padT = 22, padB = 30;
  const totalX = Math.max(1, span + fut);
  const X = i => padL + ((i - start) / totalX) * (W - padL - padR);

  const cone = [];
  if (hasCone) {
    for (let s = 0; s <= 16; s++) {
      const t = s / 16, sq = Math.sqrt(t);
      cone.push({ i: lastI + t * fut, good: last * (1 + p.wait_p95_pct / 100 * sq), bad: last * (1 + p.wait_p05_pct / 100 * sq),
                  mid: last * (1 + (p.wait_p50_pct || 0) / 100 * sq) });
    }
  }
  const bandPts = idx.filter(i => band[i]).map(i => ({ i, up: band[i][0], lo: band[i][1] }));
  const smaPts = idx.filter(i => sma[i] != null).map(i => ({ i, v: sma[i] }));
  const target = p.target_rate && Math.abs(p.target_rate / last - 1) < 0.08 ? p.target_rate : null;

  const vals = rates.concat(bandPts.flatMap(b => [b.up, b.lo]), cone.flatMap(c => [c.good, c.bad]), target ? [target] : []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const padV = (hi - lo) * 0.08 || last * 0.005;
  lo -= padV; hi += padV;
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const path = (arr, fx, fy) => arr.map((o, k) => (k ? 'L' : 'M') + fx(o).toFixed(1) + ' ' + fy(o).toFixed(1)).join('');

  const step = niceStep((hi - lo) / 4);
  const dp = Math.max(rateDp(last) - 1, Math.min(10, Math.ceil(-Math.log10(step))), 0);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(v);
  const grid = ticks.map(v => `<line x1="${padL}" x2="${W - padR + 6}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`).join('');
  const yLabels = ticks.map(v => `<text x="${W - padR + 12}" y="${(Y(v) + 4).toFixed(1)}">${fmtRate(v, dp)}</text>`).join('');
  const long = span > 150;
  const nx = W < 520 ? 3 : 5;
  const xLabels = Array.from({ length: nx }, (_, k) => {
    const i = Math.round(start + (span * k) / (nx - 1));
    return `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="${k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle'}">${fmtDate(full[i].date, long ? 'my' : false)}</text>`;
  }).join('');

  const lineD = path(idx.map((i, k) => ({ i, v: rates[k] })), o => X(o.i), o => Y(o.v));
  const areaD = lineD + `L${X(lastI).toFixed(1)} ${H - padB}L${X(idx[0]).toFixed(1)} ${H - padB}Z`;
  const bandD = bandPts.length > 1 ? path(bandPts, b => X(b.i), b => Y(b.up)) + path(bandPts.slice().reverse(), b => X(b.i), b => Y(b.lo)).replace(/^M/, 'L') + 'Z' : '';
  const smaD = smaPts.length > 1 ? path(smaPts, o => X(o.i), o => Y(o.v)) : '';
  const lx = X(lastI), ly = Y(last);

  let coneSvg = '';
  if (hasCone) {
    const coneD = path(cone, c => X(c.i), c => Y(c.good)) + path(cone.slice().reverse(), c => X(c.i), c => Y(c.bad)).replace(/^M/, 'L') + 'Z';
    const end = cone[cone.length - 1], ex = X(end.i);
    const lbl = p.deadline_days ? `Deadline · ${p.deadline_days}d` : `+${h} trading days`;
    coneSvg = `<g class="cone-g" style="transform-origin:${lx.toFixed(1)}px ${ly.toFixed(1)}px">
      <path class="cone" d="${coneD}"/><path class="cone-mid" d="${path(cone, c => X(c.i), c => Y(c.mid))}"/>
      <line class="deadline" x1="${ex.toFixed(1)}" x2="${ex.toFixed(1)}" y1="${padT}" y2="${H - padB}"/>
      <text class="lbl" x="${ex.toFixed(1)}" y="${padT - 8}" text-anchor="end">${esc(lbl)}</text>
      <text class="lbl lbl--pos" x="${(ex - 5).toFixed(1)}" y="${(Y(end.good) - 6).toFixed(1)}" text-anchor="end">good</text>
      <text class="lbl lbl--neg" x="${(ex - 5).toFixed(1)}" y="${(Y(end.bad) + 14).toFixed(1)}" text-anchor="end">bad</text></g>`;
  }
  const targetSvg = target ? `<line class="target" x1="${padL}" x2="${W - padR + 6}" y1="${Y(target).toFixed(1)}" y2="${Y(target).toFixed(1)}"/>
    <text class="lbl lbl--accent" x="${padL + 4}" y="${(Y(target) - 6).toFixed(1)}">target ${fmtRate(target)}</text>` : '';
  const outs = full.map((x, i) => i >= start && x.outlier ? `<circle class="outlier" cx="${X(i).toFixed(1)}" cy="${Y(clamp(x.rate, lo, hi)).toFixed(1)}" r="3.5"><title>Flagged as a bad print on ${fmtDate(x.date, true)}: ${fmtRate(x.rate)}</title></circle>` : '').join('');
  const summary = `${state.from} to ${state.to}, ${fmtDate(full[idx[0]].date, true)} to ${fmtDate(full[lastI].date, true)}: from ${fmtRate(rates[0])} to ${fmtRate(last)}.` +
    (hasCone ? ` Waiting ${h} trading days historically ranged from ${fmtPct(p.wait_p05_pct)} to ${fmtPct(p.wait_p95_pct)}.` : '');

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(summary)}">
    <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="ag0"/><stop offset="1" class="ag1"/></linearGradient>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>
    <g class="grid">${grid}</g><g class="axis">${yLabels}${xLabels}</g>
    ${bandD ? `<path class="band" d="${bandD}"/>` : ''}
    <path class="area" d="${areaD}"/>
    ${smaD ? `<path class="mean" d="${smaD}"/>` : ''}
    ${coneSvg}${targetSvg}
    <path class="line" d="${lineD}"/>
    ${outs}
    <circle class="today-halo" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5"/>
    <circle class="today" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5"/>
    <line class="cross" x1="0" x2="0" y1="${padT}" y2="${H - padB}"/>
    <circle class="hover-dot" r="5" cx="-20" cy="-20"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/></svg>`;

  const svg = $('svg', box), cross = $('.cross', box), dot = $('.hover-dot', box), tip = $('#tip');
  const move = e => {
    const r = svg.getBoundingClientRect();
    const fx = start + clamp((e.clientX - r.left - padL) / (W - padL - padR) * totalX, 0, span);
    let best = idx[0];
    for (const i of idx) if (Math.abs(i - fx) < Math.abs(best - fx)) best = i;
    const pt = full[best], x = X(best), y = Y(pt.rate);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    box.classList.add('is-hover');
    const fav = (last / pt.rate - 1) * 100;
    const cmp = best === lastI ? 'Latest rate' : Math.abs(fav) < 0.005 ? 'Same as today'
      : `Today is <b class="${fav > 0 ? 'pos' : 'neg'}">${Math.abs(fav).toFixed(2)}% ${fav > 0 ? 'better' : 'worse'}</b>`;
    tip.innerHTML = `<span class="tip__k">${fmtDate(pt.date, true)}</span><span class="tip__v">${fmtRate(pt.rate)}</span><span class="tip__d">${cmp}</span>`;
    tip.style.left = clamp(r.left + x, 96, innerWidth - 96) + 'px';
    tip.style.top = (r.top + y) + 'px';
    tip.classList.add('is-on');
  };
  const leave = () => { box.classList.remove('is-hover'); tip.classList.remove('is-on'); };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('pointercancel', leave);
}

function buildHist() {
  const box = $('#hist'), p = state.result;
  if (!box || !p || !p.wait_hist) return;
  const W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return;
  const { m, bins } = p.wait_hist, B = bins.length;
  const padL = 2, padR = 2, padT = 30, padB = 26;
  const bw = (W - padL - padR) / B, max = Math.max(...bins) || 1;
  const X = v => padL + clamp((v + m) / (2 * m), 0, 1) * (W - padL - padR);
  const bars = bins.map((c, i) => {
    const hgt = c ? Math.max(2, (c / max) * (H - padT - padB)) : 0;
    const mid = -m + (i + 0.5) * (2 * m / B);
    return `<rect class="bar ${mid >= 0 ? 'bar--pos' : 'bar--neg'}" style="--d:${i * 22}ms" x="${(padL + i * bw + 1).toFixed(1)}" y="${(H - padB - hgt).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${hgt.toFixed(1)}"><title>${c} of ${p.wait_hist.total} windows ended ${fmtPct(mid, 1)}</title></rect>`;
  }).join('');
  const mark = (v, label, cls, row) => v == null ? '' : `<g class="hmark ${cls}"><line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${padT - 8 + row * 0}" y2="${H - padB}"/>
    <text x="${clamp(X(v), 30, W - 30).toFixed(1)}" y="${padT - 14}" text-anchor="middle">${label} ${fmtPct(v, 1)}</text></g>`;
  const near = Math.abs(X(p.wait_p50_pct) - X(p.wait_p05_pct)) < 84 || Math.abs(X(p.wait_p95_pct) - X(p.wait_p50_pct)) < 84;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of what happened after waiting ${p.wait_horizon_obs} trading days: ${fmtFrac(p.wait_prob_better)} of ${p.wait_hist.total} historical windows ended better.">
    ${bars}
    <line class="hzero" x1="${X(0).toFixed(1)}" x2="${X(0).toFixed(1)}" y1="${padT}" y2="${H - padB + 5}"/>
    <line class="hbase" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/>
    ${mark(p.wait_p05_pct, 'bad', 'hmark--neg', 0)}${near ? '' : mark(p.wait_p50_pct, 'typical', '', 0)}${mark(p.wait_p95_pct, 'good', 'hmark--pos', 0)}
    <g class="axis"><text x="${padL}" y="${H - 6}">${fmtPct(-m, 1)}</text><text x="${X(0).toFixed(1)}" y="${H - 6}" text-anchor="middle">no change</text><text x="${W - padR}" y="${H - 6}" text-anchor="end">${fmtPct(m, 1)}</text></g></svg>`;
}

// =========================================================
// Renderers
// =========================================================
function verdictMeta(d) {
  const s = String(d || '').toUpperCase();
  if (s.startsWith('CONVERT NOW')) return { text: 'Convert now.', tone: 'pos', short: 'Convert now' };
  if (s.startsWith('CONVERT HALF')) return { text: 'Convert half now.', tone: 'pos', short: 'Convert half' };
  if (s.startsWith('CONVERT MOST')) return { text: 'Convert most of it now.', tone: 'pos', short: 'Convert 75%' };
  if (s.startsWith('SPLIT')) return { text: 'Split it. A third now.', tone: 'warn', short: 'Split in three' };
  if (s.startsWith('WAIT')) return { text: 'Wait.', tone: 'neg', short: 'Wait' };
  if (s.startsWith('NO TIMING')) return { text: 'Any day works.', tone: 'flat', short: 'Any day works' };
  return { text: d || '—', tone: 'flat', short: d || '—' };
}
function splitWords(html) {
  let w = 0;
  const wrap = (word, em) => `<span class="w" style="--w:${w++}"><span>${em ? '<em>' + word + '</em>' : word}</span></span>`;
  return html.split(/(<em>.*?<\/em>)/).filter(Boolean).map(part => {
    const em = part.startsWith('<em>');
    return (em ? part.slice(4, -5) : part).split(/\s+/).filter(Boolean).map(x => wrap(x, em)).join(' ');
  }).join(' ');
}
const secHead = (no, title, sub, id) => `
  <header class="sec-head" data-reveal>
    <p class="kicker"><span class="kicker__no">${no}</span><span>${id}</span></p>
    <h2 class="sec-title">${splitWords(title)}</h2>
    ${sub ? `<p class="sec-sub">${sub}</p>` : ''}
    <div class="rule"></div>
  </header>`;
const roll = t => `<span class="roll"><span>${t}</span><span aria-hidden="true">${t}</span></span>`;
function adviceMeta(p) {
  const k = p.advice.kind;
  return {
    text: p.advice.text,
    tone: k === 'wait' ? 'neg' : k === 'stagger' || k === 'third' ? 'warn' : k === 'any' ? 'flat' : 'pos',
    short: { now: 'Convert now', most: 'Convert 75%', half: 'Convert half', third: 'Split in three', stagger: 'Stagger it', any: 'Any day works', wait: 'Wait' }[k] || 'Decide'
  };
}

function updateCombos() {
  [['#cxFrom', state.from], ['#cxTo', state.to]].forEach(([sel, code]) => {
    const el = $(sel);
    $('.cx__code', el).textContent = code;
    $('.cx__name', el).textContent = ccyName(code);
    $('.cx__sym', el).textContent = ccySym(code);
  });
}

function rateBlock(rate, chg, date, i) {
  const up = chg > 0.0005, dn = chg < -0.0005, rateStr = fmtRate(rate);
  return `<div class="rate" id="rateBox" data-rate="${rateStr}" data-reveal style="--i:${i}">
      <p class="rate__eq mono">1 ${esc(state.from)} equals</p>
      <div class="rate__row">
        <span class="odo" aria-hidden="true" data-odo="${rateStr}"></span><span class="sr-only">${rateStr}</span>
        <span class="rate__cur">${esc(state.to)}</span>
      </div>
      <p class="rate__meta mono">
        <span class="delta ${up ? 'delta--up' : dn ? 'delta--dn' : ''}">${up ? ICON.up : dn ? ICON.dn : '■'} ${Math.abs(chg || 0).toFixed(2)}%</span>
        <span>vs previous close</span><i></i><span>${fmtDate(date, true)}</span><i></i><span>reference rate</span>
      </p>
    </div>`;
}
function dialBlock(p) {
  const cx = 120, cy = 124, R = 96;
  const pt = (s, r) => { const th = Math.PI * (1 - s / 100); return [cx + r * Math.cos(th), cy - r * Math.sin(th)]; };
  const arc = (a, b, r) => { const [x0, y0] = pt(a, r), [x1, y1] = pt(b, r); return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
  const zones = [[0, 40, 'neg'], [40, 60, 'warn'], [60, 75, 'pos2'], [75, 100, 'pos']];
  const ticks = [0, 40, 60, 75, 100].map(s => {
    const [x0, y0] = pt(s, R + 7), [x1, y1] = pt(s, R + 13), [tx, ty] = pt(s, R + 25);
    return `<line class="dial__tick" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/><text class="dial__num" x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}" text-anchor="middle">${s}</text>`;
  }).join('');
  const score = p ? clamp(p.score, 0, 100) : null;
  const stat = (k, v, d) => `<div><dt>${k}</dt><dd>${v}</dd><dd class="k">${d}</dd></div>`;
  return `
    <div class="dial${p ? '' : ' is-pending'}" data-reveal style="--i:${p ? 3 : 0}">
      <div class="dial__head mono"><span>Level score</span><span>${p ? (Math.round(p.history_days / 365 * 10) / 10) + ' yrs of history' : 'measuring'}</span></div>
      <div class="dial__gauge">
        <svg viewBox="-6 -8 252 150" role="img" aria-label="${p ? `Level score ${score} out of 100` : 'Level score is being calculated'}">
          ${zones.map(z => `<path class="dial__zone dial__zone--${z[2]}" d="${arc(z[0] + 0.7, z[1] - 0.7, R)}"/>`).join('')}
          ${ticks}
          ${p ? `<path class="dial__prog" d="${arc(0, 100, R - 9)}" pathLength="100" style="stroke-dasharray:100;stroke-dashoffset:100" data-dash="${100 - score}"/>` : ''}
          <g class="dial__needle" style="--a:-90deg" ${p ? `data-needle="${(score / 100 * 180 - 90).toFixed(1)}"` : ''}>
            <path d="M${cx - 2.2} ${cy} L${cx} ${cy - R + 16} L${cx + 2.2} ${cy} Z"/>
          </g>
          <circle class="dial__hub" cx="${cx}" cy="${cy}" r="5"/>
        </svg>
      </div>
      <div class="dial__read">
        <span class="mono">wait</span>
        <div class="dial__score"><span class="serif" ${p ? countAttr(score, 'int') : ''}>${p ? score : '··'}</span><small class="mono">out of 100</small></div>
        <span class="mono">convert</span>
      </div>
      <dl class="dial__stats">
        ${p ? stat('Better than', `<span ${countAttr(p.pct90, 'frac')}>${fmtFrac(p.pct90)}</span>`, 'of the last 90 days')
            + stat('Ranks', '#' + p.rank_1y, `of ${p._n252} days this year`)
            + stat('Convert', `<span ${countAttr(p.advice.now_pct, 'int')}>${p.advice.now_pct}</span>%`, 'of your amount today')
          : stat('Better than', '—', 'of the last 90 days') + stat('Ranks', '—', 'of the last year') + stat('Convert', '—', 'of your amount today')}
      </dl>
    </div>`;
}
function verdictBlock(p) {
  const v = adviceMeta(p);
  const tail = p.headline_tail.charAt(0).toUpperCase() + p.headline_tail.slice(1);
  return `<div class="verdict verdict--${v.tone}" data-reveal style="--i:4">
      <p class="verdict__k mono">The call</p>
      <h1 class="verdict__t"><span class="verdict__w">${esc(v.text)}<svg class="scribble" viewBox="0 0 300 14" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M3 9 C 38 3, 74 12, 118 7 S 196 4, 232 8 S 280 9, 297 5"/></svg></span></h1>
      <p class="verdict__sub">${esc(tail)}<i></i>${p.signals_good} of ${p.signals_total} signals in your favour<i></i><span class="conf conf--${esc(p.confidence)}"><b></b>${esc(p.confidence)} confidence</span></p>
      <div class="verdict__cta">
        <a class="btn" href="#steps">${roll('See the plan')}${ICON.down}</a>
        <a class="link" href="#why">Why this call</a>
      </div>
    </div>`;
}
function renderHero(opts = {}) {
  const p = state.result, body = $('#heroBody'), side = $('#heroSide');
  if (state.error) {
    body.innerHTML = `<div class="state" data-reveal><p class="state__k mono">Couldn't load ${esc(state.from)} → ${esc(state.to)}</p>
      <h1 class="state__t">${esc(String(state.error).replace(/[.\s]+$/, ''))}.</h1>
      <p class="state__d">Nothing is wrong on your side of things. Try again, or pick another pair above.</p>
      <button type="button" class="btn" id="retryBtn">${roll('Try again')}${ICON.arrow}</button></div>`;
    side.innerHTML = '';
    return;
  }
  if (state.partial && state.quick) {
    const q = state.quick;
    body.innerHTML = rateBlock(q.rate, q.chg, q.date, 0) + `
      <div class="verdict verdict--pending" data-reveal style="--i:1">
        <p class="verdict__k mono">The call</p>
        <h1 class="verdict__t verdict__t--pending">Reading three years of history<span class="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></h1>
        <p class="verdict__sub">Measuring today's rate against every trading day since ${fmtDate(addDays(TODAY, -LOOKBACK_DAYS), 'my')}.</p>
      </div>`;
    side.innerHTML = dialBlock(null);
    return;
  }
  if (!p) {
    const n = state.clean ? state.clean.series.length : 0;
    body.innerHTML = `<div class="state" data-reveal><p class="state__k mono">${esc(state.from)} → ${esc(state.to)}</p>
      <h1 class="state__t">Not enough history yet.</h1>
      <p class="state__d">Only ${n} daily rates are available for this pair and at least ${E.MIN_POINTS} are needed for an honest call. Try a more widely traded currency.</p></div>`;
    side.innerHTML = '';
    return;
  }
  const box = $('#rateBox', body), old = $('.verdict', body);
  if (opts.upgrade && box && old && box.dataset.rate === fmtRate(p.rate)) {
    // the rate is already on screen from the quick look: only swap in the verdict
    old.insertAdjacentHTML('afterend', verdictBlock(p));
    old.remove();
  } else {
    body.innerHTML = rateBlock(p.rate, p.mom1_pct, p.rate_date, 2) + verdictBlock(p);
  }
  side.innerHTML = dialBlock(p);
}

function fmtWhen(day) {
  if (day === 0) return 'Today';
  const p = addDays(TODAY, day).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${d} · in ${day} day${day === 1 ? '' : 's'}`;
}
function renderSteps() {
  const p = state.result, sec = $('#steps');
  if (!p) { sec.innerHTML = ''; return; }
  const a = p.advice, net = 1 - (p.fee_pct || 0) / 100;
  const sub = a.kind === 'wait' ? `Not a forecast: this is what has worked from levels like today's. Re-check on the date below.`
    : a.kind === 'now' || a.kind === 'any' ? 'One step. Nothing to schedule.'
    : 'Splitting protects you from being wrong about any single day.';
  const steps = a.steps.map((st, i) => {
    const big = st.pct == null ? 'Review' : st.pct === 0 ? 'Hold' : st.pct + '%';
    const part = st.pct > 0 ? state.amount * st.pct / 100 : 0;
    const amt = st.pct > 0 ? `${fmtMoney(part, state.from)}${i === 0 ? ` → ${fmtMoney(part * p.rate * net, state.to)}` : ''}` : st.pct === 0 ? 'nothing today' : 'look at the score again';
    return `<li class="step${i === 0 ? ' is-now' : ''}" style="--i:${i}"><span class="step__dot"></span>
      <p class="step__when mono">${fmtWhen(st.day)}</p>
      <p class="step__big serif">${big}</p>
      <p class="step__amt mono">${amt}</p>
      <p class="step__t">${esc(st.text)}</p></li>`;
  }).join('');
  const trig = p.trigger_rate && a.kind !== 'now' && a.kind !== 'any' ? `
    <aside class="trigger" data-reveal style="--i:2">
      <p class="mono">Early trigger</p>
      <p class="trigger__v serif">${fmtRate(p.trigger_rate)} <small>${esc(state.to)}</small></p>
      <p class="trigger__d">If 1 ${esc(state.from)} reaches this (<b>${fmtPct(p.trigger_gap_pct, 2)}</b> from today), ${p.trigger_kind === 'level' ? 'the level is back above average' : 'take it: history says much more than this rarely arrives in time'}. Convert ${a.kind === 'wait' ? 'then' : 'the next part early'}.</p>
      <div class="meter"><i style="--v:${p.trigger_prob}"></i></div>
      <p class="trigger__d">Reached within ${p.trigger_horizon} trading days <b>${fmtFrac(p.trigger_prob)}</b> of the time${p.trigger_days ? `, typically after ${p.trigger_days}` : ''}.</p>
    </aside>` : '';
  sec.innerHTML = `
    ${secHead('02', `Your move, <em>step by step</em>`, sub, 'Action plan')}
    <div class="stepwrap${trig ? ' has-trigger' : ''}">
      <ol class="steps steps--${a.steps.length}" data-reveal>${steps}</ol>${trig}
    </div>`;
}

function outcomeData() {
  const p = state.result, amt = state.amount, net = 1 - (p.fee_pct || 0) / 100;
  const now = amt * p.rate * net;
  const at = pct => pct == null ? null : amt * p.rate * (1 + pct / 100) * net;
  const list = [
    { k: 'Convert today', v: now, tone: 'now',
      d: p.fee_pct ? `after your ${p.fee_pct}% fee (−${fmtMoney(amt * p.rate * p.fee_pct / 100, state.to)})` : 'at today\'s reference rate' },
    { k: 'Wait · bad case', v: at(p.wait_p05_pct), tone: 'neg' },
    { k: 'Wait · typical', v: at(p.wait_p50_pct), tone: '' },
    { k: 'Wait · good case', v: at(p.wait_p95_pct), tone: 'pos' }
  ];
  if (p.target_rate) {
    list.push({ k: 'At your target', v: amt * p.target_rate * net, tone: 'target',
      note: p.target_gap_pct <= 0 ? 'reached today' : `${p.target_prob == null ? 'unknown' : fmtFrac(p.target_prob)} chance in time` });
  }
  return list.map(o => {
    if (o.tone === 'now') return o;
    if (o.v == null) return { ...o, d: 'not enough history' };
    const diff = o.v - now;
    const zero = Math.abs(diff) < Math.max(1e-9, Math.abs(now) * 1e-6);
    const d = zero ? 'same as today' : `${diff > 0 ? '+' : '−'}${fmtMoney(Math.abs(diff), state.to)} vs today`;
    return { ...o, cls: zero ? '' : diff > 0 ? 'pos' : 'neg', d: o.note ? `${d} · ${o.note}` : d };
  });
}
function planNote() {
  const p = state.result;
  const hz = `${p.wait_horizon_obs} trading day${p.wait_horizon_obs === 1 ? '' : 's'}`;
  return `Bad and good cases are the 5th and 95th percentile of what actually happened after waiting ${hz}, across ${p.wait_windows ? p.wait_windows.toLocaleString('en-US') : 'the available'} past windows. ` +
    (p.fee_pct ? `Every amount is what lands after your ${p.fee_pct}% provider fee.` : 'Add your provider fee to see what actually lands in your account.');
}
const outTile = (o, i, extra = '') => `<div class="out out--${o.tone || 'mid'}${extra}" data-out="${i}">
    <p class="out__k mono">${o.k}</p>
    <p class="out__v serif" ${o.v != null ? countAttr(o.v, 'money', `data-cur="${esc(state.to)}" data-dur="500"`) : ''}>${fmtMoney(o.v, state.to)}</p>
    <p class="out__d ${o.cls || ''}">${o.d}</p></div>`;
const DEADLINES = [[0, 'None'], [7, '1 wk'], [14, '2 wks'], [30, '1 mo'], [90, '3 mo']];
function renderPlan(keep) {
  const p = state.result, sec = $('#plan');
  if (!p) { sec.innerHTML = ''; return; }
  const outs = outcomeData();
  if (keep && $('#outs', sec)) { updateOuts(); return; }
  const custom = !DEADLINES.some(d => d[0] === state.plan.deadline);
  sec.innerHTML = `
    ${secHead('03', `What you'd get, <em>now or later</em>`, 'Set your amount, deadline, fee and target. Every number on this page follows your plan.', 'In money')}
    <div class="plan">
      <div class="plan__controls" data-reveal>
        <label class="field field--amount"><span class="field__k mono">Amount to convert</span>
          <span class="field__box"><input id="amount" inputmode="decimal" autocomplete="off" value="${state.amount.toLocaleString('en-US')}" aria-label="Amount in ${esc(state.from)}"><i>${esc(state.from)}</i></span></label>
        <div class="field"><span class="field__k mono" id="dlLabel">I must convert within</span>
          <div class="segs" id="dlSegs" role="radiogroup" aria-labelledby="dlLabel"><span class="segs__thumb" aria-hidden="true"></span>
            ${DEADLINES.map(d => `<button type="button" role="radio" data-deadline="${d[0]}" aria-checked="${state.plan.deadline === d[0]}">${d[1]}</button>`).join('')}
            ${custom ? `<button type="button" role="radio" data-deadline="${state.plan.deadline}" aria-checked="true">${state.plan.deadline} d</button>` : ''}
          </div></div>
        <label class="field"><span class="field__k mono">Provider fee</span>
          <span class="field__box field__box--sm"><input id="fee" inputmode="decimal" autocomplete="off" placeholder="0" value="${state.plan.fee || ''}" aria-label="Provider fee in percent"><i>%</i></span></label>
        <label class="field"><span class="field__k mono">Target rate</span>
          <span class="field__box field__box--sm"><input id="target" inputmode="decimal" autocomplete="off" placeholder="${fmtRate(p.rate * 1.01)}" value="${state.plan.target || ''}" aria-label="Target rate in ${esc(state.to)} per ${esc(state.from)}"><i>${esc(state.to)}</i></span></label>
      </div>
      <div class="outs outs--${outs.length}" id="outs" data-reveal-group>${outs.map((o, i) => outTile(o, i)).join('')}</div>
      <p class="plan__note" id="planNote" data-reveal>${planNote()}</p>
    </div>`;
}
function updateOuts() {
  if (!state.result) return;
  const outs = outcomeData(), wrap = $('#outs');
  if (!wrap) return;
  if ($$('.out', wrap).length !== outs.length) {
    // a target was added or removed: rebuild the row without replaying the entrance
    wrap.className = `outs outs--${outs.length}`;
    wrap.innerHTML = outs.map((o, i) => outTile(o, i, ' is-visible is-done')).join('');
    $$('.out', wrap).forEach(el => el.setAttribute('data-reveal', ''));
    $$('.out__v', wrap).forEach(v => { v.dataset.counted = '1'; v.dataset.value = v.dataset.count; });
  } else {
    outs.forEach((o, i) => {
      const box = $(`[data-out="${i}"]`, wrap);
      const v = $('.out__v', box), d = $('.out__d', box);
      v.dataset.counted = '1';
      if (o.v != null) animateNumber(v, o.v); else v.textContent = '—';
      d.textContent = o.d;
      d.className = 'out__d ' + (o.cls || '');
    });
  }
  const note = $('#planNote');
  if (note) note.textContent = planNote();
  const t = $('#target');
  if (t && document.activeElement !== t) t.placeholder = fmtRate(state.result.rate * 1.01);
}

function renderHistory() {
  const p = state.result, sec = $('#history');
  if (!p) { sec.innerHTML = ''; return; }
  const posCard = (label, pct, pos, lo, hi) => `
    <div class="pos"><p class="pos__k mono">${label}</p>
      <p class="pos__v">Better than <strong>${fmtFrac(pct)}</strong> of days</p>
      <div class="pos__track"><i style="--v:${pos}"></i><b style="left:${(pos * 100).toFixed(1)}%"></b></div>
      <p class="pos__ends mono"><span>low ${fmtRate(lo)}</span><span>high ${fmtRate(hi)}</span></p></div>`;
  sec.innerHTML = `
    ${secHead('04', `Where today sits <em>in history</em>`, 'The shaded cone is how far the rate has typically moved by your deadline, for better or worse.', 'History')}
    <div class="chartwrap" data-reveal>
      <div class="chartbar">
        <div class="legend mono">
          <span><i class="lg lg--line"></i>rate</span><span><i class="lg lg--mean"></i>30-day average</span><span><i class="lg lg--band"></i>usual range</span>
          ${p.wait_p05_pct != null ? '<span><i class="lg lg--cone"></i>if you wait</span>' : ''}${p.target_rate ? '<span><i class="lg lg--target"></i>target</span>' : ''}
        </div>
        <div class="segs segs--sm" id="rangeSegs" role="radiogroup" aria-label="Chart range"><span class="segs__thumb" aria-hidden="true"></span>
          ${Object.keys(RANGES).map(k => `<button type="button" role="radio" data-range="${k}" aria-checked="${state.range === k}">${k}</button>`).join('')}
        </div>
      </div>
      <div class="chart" id="chart"></div>
    </div>
    <div class="perf" data-reveal>
      <p class="perf__k mono">What 1 ${esc(state.from)} buys, change over</p>
      <div class="perf__row">${p.perf.map((x, i) => `<div class="perf__i" style="--i:${i}"><span class="mono">${x.k === 'All' ? (Math.round(p.history_days / 365 * 10) / 10) + 'Y' : x.k}</span><b class="${x.v > 0.005 ? 'pos' : x.v < -0.005 ? 'neg' : ''}">${fmtPct(x.v, 1)}</b><i class="${x.v >= 0 ? 'up' : 'dn'}" style="--v:${Math.min(1, Math.abs(x.v || 0) / Math.max(0.01, ...p.perf.map(y => Math.abs(y.v || 0)))).toFixed(3)}"></i></div>`).join('')}</div>
    </div>
    <div class="posgrid" data-reveal-group>
      ${posCard('Last 30 days', p.pct30, p.range_pos30, p.min30, p.max30)}
      ${posCard('Last 90 days', p.pct90, p.range_pos90, p.min90, p.max90)}
      ${posCard('Last year', p.pct252, p.range_pos252, p.min252, p.max252)}
    </div>`;
  buildChart();
}

const SIGNAL_TEXT = {
  '90-day percentile': 'Beats at least 60% of the last 90 days',
  '1-year percentile': 'Beats at least 60% of the last year',
  'Bollinger position': 'In the favourable part of its usual 20-day range',
  'z-score vs 90 days': 'Half a standard deviation above the 90-day average',
  'RSI': 'Recent momentum leans your way',
  'Above 30-day average': 'Better than the 30-day average',
  '7-day vs 30-day trend': 'The last week beat the last month'
};
const SIGNAL_NAME = {
  '90-day percentile': 'Three-month level', '1-year percentile': 'One-year level', 'Bollinger position': 'Range position',
  'z-score vs 90 days': 'Distance from average', 'RSI': 'Momentum', 'Above 30-day average': 'Monthly average', '7-day vs 30-day trend': 'Short-term trend'
};
function renderWhy() {
  const p = state.result, sec = $('#why');
  if (!p) { sec.innerHTML = ''; return; }
  const sig = String(p.signals_detail).split(';').filter(Boolean).map(x => { const j = x.lastIndexOf('='); return { name: x.slice(0, j), yes: x.slice(j + 1) === '1' }; });
  const rest = p.reasons.slice(1), CL = 4;
  sec.innerHTML = `
    ${secHead('05', `Why <em>this</em> call`, 'Rule-based and explainable. No forecast, just today measured against the past.', 'The reasoning')}
    <div class="why">
      <div class="reasons" data-reveal>
        <p class="reasons__lead">${esc(p.reasons[0])}</p>
        <ol class="reasons__list${rest.length > CL ? ' is-clamped' : ''}" id="reasonList">
          ${rest.map((s, i) => `<li${i >= CL ? ' class="extra"' : ''}><span class="mono">${String(i + 1).padStart(2, '0')}</span><p>${esc(s)}</p></li>`).join('')}
        </ol>
        ${rest.length > CL ? `<button type="button" class="link link--btn" id="reasonToggle" aria-expanded="false" aria-controls="reasonList">Show all ${rest.length} reasons</button>` : ''}
      </div>
      <div class="signals" data-reveal style="--i:1">
        <div class="signals__head"><h3>Seven signals</h3><p class="mono"><b>${p.signals_good}</b> / ${p.signals_total} in your favour</p></div>
        <div class="signals__pips" aria-hidden="true">${sig.map(s => `<i class="${s.yes ? 'on' : ''}"></i>`).join('')}</div>
        <ul class="signals__list">
          ${sig.map(s => `<li class="signal ${s.yes ? 'is-yes' : 'is-no'}"><span class="signal__i">${s.yes ? ICON.check : ICON.cross}</span>
            <span class="signal__t"><b>${esc(SIGNAL_NAME[s.name] || s.name)}</b><small>${esc(SIGNAL_TEXT[s.name] || '')}</small></span>
            <span class="signal__s mono">${s.yes ? 'yes' : 'no'}</span></li>`).join('')}
        </ul>
      </div>
    </div>`;
}

function renderOdds() {
  const p = state.result, sec = $('#odds');
  if (!p) { sec.innerHTML = ''; return; }
  if (p.wait_prob_better == null || !p.wait_hist) {
    sec.innerHTML = `${secHead('06', `The odds of <em>waiting</em>`, '', 'If you wait')}<p class="muted" data-reveal>${p._flat ? 'This pair is flat, so waiting changes nothing.' : 'There is not enough history for this horizon yet.'}</p>`;
    return;
  }
  const hz = `${p.wait_horizon_obs} trading day${p.wait_horizon_obs === 1 ? '' : 's'}`;
  const hl = h => { const d = Math.round(h * 7 / 5); return d < 7 ? d + 'd' : Math.round(d / 7) + 'w'; };
  const curve = p.wait_curve || [];
  const cond = curve.length && curve[0].conditional;
  const curveHtml = curve.length >= 2 ? `
    <div class="curve" data-reveal>
      <div class="curve__head">
        <h3 class="serif">How long is worth waiting?</h3>
        <p>${cond ? 'Starting only from past days at a level like today\'s' : 'Starting from any past day'}: how often waiting ended better (bar), and the typical result (below).${p.wait_best ? ` The marked window is the shortest wait that captured most of the gain.` : ' No window has reliably paid.'}</p>
      </div>
      <div class="curve__bars">
        ${curve.map((c, i) => `<div class="cbar${p.wait_best && p.wait_best.h === c.h ? ' is-best' : ''}" style="--i:${i}" title="${c.n} past cases">
          <span class="cbar__p mono">${fmtFrac(c.prob)}</span>
          <span class="cbar__col"><i class="${c.prob >= 0.5 ? 'up' : 'dn'}" style="--v:${c.prob}"></i></span>
          <span class="cbar__t ${c.p50 > 0.005 ? 'pos' : c.p50 < -0.005 ? 'neg' : ''}">${fmtPct(c.p50, 2)}</span>
          <span class="cbar__h mono">${hl(c.h)}</span></div>`).join('')}
      </div>
    </div>` : '';
  sec.innerHTML = `
    ${secHead('06', `The odds of <em>waiting</em>`, `What actually happened every time someone in your position waited ${hz}.`, 'If you wait')}
    <div class="odds">
      <div class="odds__l" data-reveal>
        <p class="odds__big serif"><span ${countAttr(p.wait_prob_better, 'frac')}>${fmtFrac(p.wait_prob_better)}</span></p>
        <p class="odds__t">of the time, waiting ${hz} ended with a <strong>better</strong> rate than converting on the day.</p>
        <dl class="trio">
          <div><dt class="mono">Bad case</dt><dd class="neg">${fmtPct(p.wait_p05_pct)}</dd></div>
          <div><dt class="mono">Typical</dt><dd>${fmtPct(p.wait_p50_pct, 2)}</dd></div>
          <div><dt class="mono">Good case</dt><dd class="pos">${fmtPct(p.wait_p95_pct)}</dd></div>
          <div><dt class="mono">Dip on the way</dt><dd class="neg">${fmtPct(p.wait_dip_p50_pct)}</dd></div>
        </dl>
      </div>
      <div class="odds__r" data-reveal style="--i:1">
        <div class="hist" id="hist"></div>
        <p class="cap mono">${p.wait_hist.total.toLocaleString('en-US')} overlapping windows since ${fmtDate(p.first_date, true)} · left of the line = waiting cost you</p>
      </div>
    </div>${curveHtml}`;
  buildHist();
}

function cell(k, v, d, tone = '', extra = '') {
  return `<div class="cell${tone ? ' cell--' + tone : ''}"><p class="cell__k mono">${k}</p><p class="cell__v serif">${v}</p>${extra}<p class="cell__d">${d}</p></div>`;
}
function renderDetails() {
  const p = state.result, sec = $('#details');
  if (!p) { sec.innerHTML = ''; return; }
  const cells = [];
  if (p.fee_pct) {
    const r = p.fee_vs_weekly_move;
    cells.push(cell('Fee check', r != null ? `${r.toFixed(1)}× <small>a typical week</small>` : `${p.fee_pct}%`,
      r == null ? 'This pair barely moves, so the fee is the whole story. Compare providers.'
        : r >= 1 ? `Your ${p.fee_pct}% fee is larger than a normal week's move (±${p.exp_move7_pct}%). Shopping for a cheaper provider beats perfect timing.`
        : `Your ${p.fee_pct}% fee is smaller than a normal week's move (±${p.exp_move7_pct}%), so timing still matters.`, r == null || r >= 1 ? 'warn' : ''));
  } else {
    cells.push(cell('Fee check', '<small>Add your fee</small>', 'Enter your provider\'s fee in the plan above to see whether fees or timing matter more for you.', 'muted'));
  }
  if (p.target_rate) {
    const reached = p.target_gap_pct <= 0;
    cells.push(cell(`Target ${fmtRate(p.target_rate)}`, reached ? 'Reached' : `${fmtPct(p.target_gap_pct, 2)} <small>to go</small>`,
      reached ? 'Today\'s rate is at or beyond your target.' : `Touched within the horizon ${fmtFrac(p.target_prob)} of the time, historically.`,
      reached ? 'pos' : '', `<div class="meter"><i style="--v:${reached ? 1 : p.target_prob || 0}"></i></div>`));
  }
  const R = {
    'mean-reverting': ['Snaps back', 'Extremes in this pair have tended to fade back toward the average.'],
    'trending': ['Trends', 'Moves in this pair have tended to continue for a while before turning.'],
    'random-like': ['Random walk', 'No reliable pattern. Splitting your transfer is the honest hedge.'],
    'unknown': ['Unclassified', 'This pair moves too little, or has too little history, to classify.']
  }[p.regime] || [p.regime, ''];
  cells.push(cell('Behaviour', R[0], `${R[1]}${p.variance_ratio5 != null ? ` Variance ratio ${p.variance_ratio5.toFixed(2)}.` : ''}`));
  if (p.edge_bucket_mean7 != null && p.edge_base_mean7 != null) {
    const diff = p.edge_bucket_mean7 - p.edge_base_mean7;
    cells.push(cell('Honesty check', `${fmtPct(p.edge_bucket_mean7, 2)} <small>vs ${fmtPct(p.edge_base_mean7, 2)}</small>`,
      `Average move the week after ${p.edge_n} similar days, against all days. ${Math.abs(diff) < 0.05 ? 'No real edge: the level alone has not predicted what comes next.' : diff < 0 ? 'Levels like this have tended to fade.' : 'Levels like this have tended to keep improving.'}`));
  }
  const hot = (p.vol_ratio || 0) > 1.5;
  cells.push(cell('Volatility', `±${p.exp_move7_pct}% <small>a week</small>`,
    `${p.vol30_ann_pct}% a year at the current pace${p.vol_ratio != null ? `, ${p.vol_ratio.toFixed(2)}× its 90-day norm` : ''}. ${hot ? 'Unusually jumpy right now.' : 'Within its normal range.'}`, hot ? 'warn' : ''));
  if (p.base_peers) {
    cells.push(cell(`${esc(state.from)} strength`, `${p.base_strong_count} <small>of ${p.base_peers} majors</small>`,
      `${esc(state.from)} is near a 90-day high against ${p.base_strong_count} major currencies. ${p.rel_mom30_vs_basket != null && Math.abs(p.rel_mom30_vs_basket) >= 1.5 ? `This pair moved ${fmtPct(p.rel_mom30_vs_basket)} against the basket in a month, so the story is about ${esc(state.to)}.` : `This pair is moving in step with the others.`}`,
      '', `<div class="meter"><i style="--v:${p.base_strong_count / p.base_peers}"></i></div>`));
  }
  if (p.daily_var95_pct != null) {
    const net = 1 - (p.fee_pct || 0) / 100;
    cells.push(cell('A bad day', `${fmtPct(p.daily_var95_pct, 2)} <small>one day in twenty</small>`,
      `On your amount that is about ${fmtMoney(Math.abs(state.amount * p.rate * net * p.daily_var95_pct / 100), state.to)} lost overnight. A good day of the same rarity is ${fmtPct(p.daily_up95_pct, 2)}.`));
  }
  if (p.wait_mean_pct != null) {
    const flatish = Math.abs(p.wait_mean_pct) < 0.1;
    cells.push(cell('Average pay-off of waiting', `${fmtPct(p.wait_mean_pct, 2)} <small>over ${p.wait_horizon_obs} days</small>`,
      `Averaged over every past window. ${flatish ? 'Close to zero: on average, waiting has been a coin flip.' : p.wait_mean_pct > 0 ? 'Positive: this pair has drifted your way over time.' : 'Negative: this pair has drifted against you over time.'} A typical dip along the way is ${fmtPct(p.wait_dip_p50_pct)}, a bad one ${fmtPct(p.wait_dip_p05_pct)}.`,
      !flatish && p.wait_mean_pct < 0 ? 'warn' : ''));
  }
  if (p.streak_len) {
    const fav = p.streak_dir === 'up';
    cells.push(cell('Current run', `${p.streak_len} day${p.streak_len === 1 ? '' : 's'} <small>${fav ? 'in your favour' : 'against you'}</small>`,
      `The rate has moved ${fav ? 'your way' : 'against you'} for ${p.streak_len} trading day${p.streak_len === 1 ? '' : 's'} in a row. ${p.autocorr1 != null && Math.abs(p.autocorr1) < 0.1 ? 'In this pair one day says almost nothing about the next.' : p.autocorr1 > 0 ? 'Moves here have tended to follow through the next day.' : 'Moves here have tended to reverse the next day.'}`));
  }
  if (p.weekdays && p.weekdays.every(w => w.n >= 20)) {
    const best = p.weekdays.slice().sort((a, b) => b.mean - a.mean)[0];
    const sig = Math.abs(best.t) >= 2;
    const mx = Math.max(0.0001, ...p.weekdays.map(w => Math.abs(w.mean)));
    cells.push(cell('Day of the week', sig ? `${best.d} <small>has been best</small>` : `No pattern`,
      sig ? `Over two years ${best.d} moves averaged ${fmtPct(best.mean, 3)}. A small effect, worth a tie-break at most.`
          : `Average move by weekday over two years. None is statistically reliable, so do not plan around the calendar.`, sig ? '' : '',
      `<div class="wk">${p.weekdays.map(w => `<span title="${fmtPct(w.mean, 3)} average"><i class="${w.mean >= 0 ? 'up' : 'dn'}" style="--v:${(Math.abs(w.mean) / mx).toFixed(3)}"></i><em class="mono">${w.d.charAt(0)}</em></span>`).join('')}</div>`));
  }
  const stale = p.data_age_days > E.STALE_DAYS;
  cells.push(cell('Data trust', `${p.points.toLocaleString('en-US')} <small>trading days</small>`,
    `Since ${fmtDate(p.first_date, true)}. ${p.outliers_flagged} bad print${p.outliers_flagged === 1 ? '' : 's'} removed, ${state.clean.weekends} weekend prints ignored. Latest rate ${fmtDate(p.rate_date, true)}${stale ? `, which is ${p.data_age_days} days old` : ''}.`, stale ? 'warn' : ''));
  sec.innerHTML = `
    ${secHead('07', `The details <em>that matter</em>`, 'Fees, targets and how the pair behaves often outweigh the exact day you choose.', 'Fine print')}
    <div class="cells" data-reveal-group>${cells.join('')}</div>`;
}

const PRO = [
  ['pct30', '30-day percentile', 'frac', 'Share of the last 30 trading days that were as good or worse for you.'],
  ['pct90', '90-day percentile', 'frac', 'Share of the last 90 trading days that were as good or worse for you.'],
  ['pct252', '1-year percentile', 'frac', 'Share of the last year that was as good or worse for you.'],
  ['rank_1y', 'Rank this year', 'rank', '1 means today is the best day of the last year.'],
  ['days_since_better', 'Days since better', 'int', 'Calendar days since a strictly better rate. Blank means never in this history.'],
  ['vs_best90_pct', 'Vs 90-day best', 'spct', 'How far today is below the best rate of the last 90 days.'],
  ['vs_best252_pct', 'Vs 1-year best', 'spct', 'How far today is below the best rate of the last year.'],
  ['z90', 'z-score, 90d', 'dec2', 'Distance from the 90-day average, in standard deviations.'],
  ['rsi14', 'RSI (14)', 'dec1', 'Momentum oscillator. Above 70 is stretched high, below 30 stretched low.'],
  ['macd_hist', 'MACD histogram', 'sig', 'MACD minus its signal line. Positive means short-term momentum is up.'],
  ['boll_pctB', 'Bollinger %B', 'dec2', '1 is the top of the usual 20-day range, 0 is the bottom.'],
  ['vol30_ann_pct', 'Volatility, annual', 'pct', '30-day volatility scaled to a year.'],
  ['vol_ratio', 'Vol ratio 30/90', 'dec2', 'Recent volatility against its 90-day norm. Above 1.5 is elevated.'],
  ['exp_move7_pct', 'Typical week', 'pm', 'One standard deviation of movement over five trading days.'],
  ['variance_ratio5', 'Variance ratio', 'dec2', 'About 1 is a random walk, below 1 snaps back, above 1 trends.'],
  ['autocorr1', 'Autocorrelation', 'dec2', 'How much one day\'s move predicts the next day\'s.'],
  ['trend_slope30_pct_day', 'Trend, 30d', 'spct3', 'Slope of the 30-day trend in percent per day.'],
  ['trend_r2_30', 'Trend fit R²', 'dec2', 'How clean the 30-day trend is, from 0 to 1.'],
  ['mom7_pct', '7-day change', 'spct', 'Change over the last 7 trading days.'],
  ['mom30_pct', '30-day change', 'spct', 'Change over the last 30 trading days.'],
  ['sma30', '30-day average', 'rate', 'Simple average of the last 30 trading days.'],
  ['sma90', '90-day average', 'rate', 'Simple average of the last 90 trading days.'],
  ['wait_mean_pct', 'Avg wait outcome', 'spct', 'Average result of waiting to your horizon, over every past window.'],
  ['wait_dip_p05_pct', 'Worst dip, 1 in 20', 'spct', 'How far the rate fell at its worst while waiting, in a bad case.'],
  ['daily_var95_pct', 'Bad day, 1 in 20', 'spct', 'One trading day in twenty is worse than this.'],
  ['trigger_prob', 'Trigger chance', 'frac', 'How often the early-trigger rate was reached within the horizon.'],
  ['min252', '1-year low', 'rate', 'Lowest rate of the last year.'],
  ['max252', '1-year high', 'rate', 'Highest rate of the last year.']
];
function fmtMetric(v, f) {
  if (v == null || (typeof v === 'number' && !isFinite(v))) return '—';
  switch (f) {
    case 'frac': return fmtFrac(v);
    case 'rank': return '#' + v;
    case 'int': return Math.round(v).toLocaleString('en-US');
    case 'dec1': return v.toFixed(1);
    case 'dec2': return v.toFixed(2);
    case 'sig': return Number(v.toPrecision(3)).toString();
    case 'pct': return v.toFixed(2) + '%';
    case 'pm': return '±' + v.toFixed(2) + '%';
    case 'spct': return fmtPct(v, 2);
    case 'spct3': return fmtPct(v, 3);
    case 'rate': return fmtRate(v);
    default: return String(v);
  }
}
function renderPro() {
  const p = state.result, sec = $('#pro');
  if (!p) { sec.innerHTML = ''; return; }
  sec.innerHTML = `<div class="pro__in">
    ${secHead('+', `Every number <em>behind the call</em>`, 'Hover or focus a figure for what it means.', 'Pro mode').replace('class="sec-head" data-reveal', 'class="sec-head is-visible"')}
    <div class="metrics">${PRO.map(([k, label, f, tip]) => `
      <div class="metric" tabindex="0" data-tip="${esc(tip)}"><p class="metric__k mono">${esc(label)}</p><p class="metric__v">${fmtMetric(p[k], f)}</p></div>`).join('')}
    </div></div>`;
}

function renderMajors() {
  const sec = $('#majors'), b = state.basket;
  const head = secHead('08', `${esc(state.from)} against <em>the majors</em>`, `How strong ${esc(ccyName(state.from))} is right now. Pick a row to analyse that pair.`, 'Strength');
  if (state.basketState === 'loading' || (b && b.from !== state.from)) {
    sec.innerHTML = head + `<div class="mtable">${'<div class="sk sk--row"></div>'.repeat(6)}</div>`;
    return;
  }
  if (state.basketState === 'error' || !b || !b.items.length) {
    sec.innerHTML = head + `<p class="muted" data-reveal>The comparison with major currencies could not be loaded right now. The analysis above is unaffected.</p>`;
    return;
  }
  const rows = b.items.slice().sort((x, y) => y.pct90 - x.pct90);
  sec.innerHTML = head + `
    <div class="mtable" role="list">
      <div class="mrow mrow--head mono" aria-hidden="true"><span>Currency</span><span>Rate</span><span>Day</span><span>Month</span><span>90-day position</span><span></span><span></span></div>
      <div data-reveal-group>
      ${rows.map(i => `<button type="button" class="mrow${i.code === state.to ? ' is-active' : ''}" role="listitem" data-to="${i.code}" aria-label="Analyse ${esc(state.from)} to ${i.code}">
        <span class="mrow__c"><b>${i.code}</b><small>${esc(ccyName(i.code))}</small></span>
        <span class="mrow__r mono">${fmtRate(i.rate)}</span>
        <span class="mrow__d mono ${i.chg1 > 0.005 ? 'pos' : i.chg1 < -0.005 ? 'neg' : ''}">${fmtPct(i.chg1, 2)}</span>
        <span class="mrow__m mono ${i.mom30 > 0.005 ? 'pos' : i.mom30 < -0.005 ? 'neg' : ''}">${fmtPct(i.mom30, 1)}</span>
        <span class="mrow__p"><span class="posbar"><i style="--v:${i.pct90.toFixed(3)}"></i></span><small class="mono">${fmtFrac(i.pct90)}</small></span>
        <span class="mrow__s spark" data-basket="${i.code}"></span>
        <span class="mrow__go">${ICON.arrow}</span>
      </button>`).join('')}
      </div>
    </div>`;
}

function renderTicker() {
  const b = state.basket, el = $('#ticker');
  if (!b || b.from !== state.from || !b.items.length) { el.hidden = true; return; }
  const item = i => `<button type="button" class="tick" data-to="${i.code}" tabindex="-1"><b>${esc(state.from)}/${i.code}</b><span>${fmtRate(i.rate)}</span><em class="${i.chg1 > 0.005 ? 'pos' : i.chg1 < -0.005 ? 'neg' : ''}">${i.chg1 > 0.005 ? '▲' : i.chg1 < -0.005 ? '▼' : '■'} ${Math.abs(i.chg1).toFixed(2)}%</em></button>`;
  const set = b.items.map(item).join('');
  $('#tickerTrack').innerHTML = `<div class="ticker__set">${set}</div><div class="ticker__set" aria-hidden="true">${set}</div>`;
  el.hidden = false;
}

function renderWatch() {
  const sec = $('#watch');
  if (state.sheetState === 'off') { sec.innerHTML = ''; return; }
  const head = secHead('09', `Your <em>watchlist</em>`, 'The pairs tracked by your Google Sheet pipeline, as of its last daily run.', 'From your Sheet');
  if (state.sheetState === 'loading') { sec.innerHTML = head + `<div class="wgrid">${'<div class="sk sk--card"></div>'.repeat(3)}</div>`; return; }
  if (state.sheetState === 'error' || !state.sheet.length) {
    sec.innerHTML = head + `<p class="muted" data-reveal>${state.sheetState === 'error'
      ? 'Your Google Sheet endpoint could not be reached, so the watchlist is hidden for now. Live analysis above does not depend on it.'
      : 'Your Sheet is connected but has no decisions yet. Run the pipeline once in Apps Script.'}</p>`;
    return;
  }
  const C = 2 * Math.PI * 17;
  sec.innerHTML = head + `<div class="wgrid" data-reveal-group>
    ${state.sheet.map((p, i) => {
      const v = verdictMeta(p.decision), s = clamp(p.score || 0, 0, 100);
      const on = p.from === state.from && p.to === state.to;
      const rate = p.rate ? (p.hib ? p.rate : 1 / p.rate) : null;
      return `<button type="button" class="wcard${on ? ' is-active' : ''}" data-pairfrom="${p.from}" data-pairto="${p.to}" aria-label="Analyse ${p.from} to ${p.to}">
        <span class="wcard__top"><span class="wcard__pair serif">${p.from}<i>→</i>${p.to}</span>
          <span class="wcard__score"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="ring-t" cx="20" cy="20" r="17"/><circle class="ring-b" cx="20" cy="20" r="17" style="stroke-dasharray:${C.toFixed(2)};stroke-dashoffset:${C.toFixed(2)}" data-dash="${(C * (1 - s / 100)).toFixed(2)}"/></svg><b class="mono">${s}</b></span></span>
        <span class="wcard__spark spark" data-sheet="${i}"></span>
        <span class="wcard__bot"><span class="tag tag--${v.tone}">${esc(v.short)}</span><span class="mono">${fmtRate(rate)} · ${fmtDate(p.rate_date)}</span></span>
        <span class="wcard__go">${ICON.arrow}</span>
      </button>`;
    }).join('')}</div>`;
}

function renderStatus() {
  const p = state.result, el = $('#status');
  el.classList.remove('is-stale', 'is-error');
  if (state.error) { el.classList.add('is-error'); $('#statusText').textContent = 'Rates unavailable'; }
  else if (state.partial) { $('#statusText').textContent = 'Analysing history'; }
  else if (!p) { $('#statusText').textContent = 'Limited data'; el.classList.add('is-stale'); }
  else {
    const stale = p.data_age_days > E.STALE_DAYS;
    el.classList.toggle('is-stale', stale);
    $('#statusText').textContent = stale ? `Rates ${p.data_age_days} days old` : `Rates as of ${fmtDate(p.rate_date)}`;
  }
  $('#footMeta').textContent = p ? `${state.from}/${state.to} · ${p.points.toLocaleString('en-US')} trading days analysed · source: Frankfurter (frankfurter.dev)` : 'Source: Frankfurter (frankfurter.dev)';
  document.title = p ? `${state.from} → ${state.to} · ${adviceMeta(p).short} · FX Timing Helper` : 'FX Timing Helper';
}

function settle(instant) {
  hydrateSparks();
  initReveal(document, instant);
  syncSegs();
}
function renderPair(opts = {}) {
  const run = () => {
    renderStatus();
    renderHero(opts);
    renderSteps();
    renderPlan(opts.keepPlan);
    renderHistory();
    renderWhy();
    renderOdds();
    renderDetails();
    renderPro();
    if (!opts.keepLists) { renderMajors(); renderWatch(); renderTicker(); }
    settle(opts.instant);
  };
  if (opts.instant) withInstant(run); else run();
}

// =========================================================
// Pair selection
// =========================================================
function syncUrl() {
  const q = new URLSearchParams(location.search);
  q.set('from', state.from); q.set('to', state.to);
  try { history.replaceState(null, '', '?' + q.toString() + location.hash); } catch (e) { /* file:// */ }
}
async function setPair(from, to, opts = {}) {
  if (!from || !to || from === to) return;
  const fromChanged = from !== state.from;
  state.from = from; state.to = to;
  store.set('fx_from', from); store.set('fx_to', to);
  syncUrl();
  loadPlan();
  if (opts.swap && !reduceMotion) {
    const bar = $('#pairbar');
    bar.classList.remove('is-swapping'); void bar.offsetWidth; bar.classList.add('is-swapping');
    setTimeout(updateCombos, 170);
    setTimeout(() => bar.classList.remove('is-swapping'), 520);
  } else updateCombos();

  const token = ++state.token;
  const cached = seriesCache.has(from + '/' + to) || seriesCache.has(to + '/' + from);
  const cls = document.body.classList;
  cls.add('is-loading'); cls.remove('is-analysing');
  state.rows = null; state.result = null; state.clean = null; state.partial = false; state.quick = null;

  // the basket only depends on the "from" currency: fetch it alongside, not after
  if (fromChanged || !state.basket || state.basket.from !== from) {
    state.basket = basketCache.get(from) || null;
    state.basketState = state.basket ? 'ok' : 'loading';
    if (!opts.silent) withInstant(() => { renderMajors(); renderTicker(); settle(true); });
    if (!state.basket) refreshBasket(from);
  }

  let settled = false;
  if (!cached && !opts.silent) {
    getQuick(from, to).then(q => {
      if (token !== state.token || settled || !q) return;
      state.partial = true; state.quick = q; state.error = null;
      cls.remove('is-loading'); cls.add('is-analysing');
      renderStatus(); renderHero(); initReveal($('.hero'));
    }).catch(() => { /* the full request will report any real problem */ });
  }

  let rows = null, error = null;
  try { rows = await getSeries(from, to); } catch (e) { error = (e && e.message) || 'Something went wrong'; }
  if (token !== state.token) return;
  settled = true;
  const upgrade = state.partial;
  state.partial = false; state.quick = null;
  state.rows = rows; state.error = error;
  cls.remove('is-loading', 'is-analysing');
  analyse();
  if (!opts.silent) renderPair({ upgrade });
}
async function refreshBasket(from) {
  try { const b = await getBasket(from); if (state.from !== from) return; state.basket = b; state.basketState = 'ok'; }
  catch (e) { if (state.from !== from) return; state.basket = null; state.basketState = 'error'; }
  if (state.result) {
    // fold the basket into the reasoning that is already on screen
    analyse();
    withInstant(() => { renderWhy(); renderDetails(); settle(true); });
  }
  renderMajors(); renderTicker();
  hydrateSparks($('#majors'));
  initReveal($('#majors'));
  syncSegs();
}
function planChanged() {
  savePlan();
  if (!state.rows || state.partial) return;
  analyse();
  renderPair({ instant: true, keepPlan: true, keepLists: true });
}

// =========================================================
// Currency picker
// =========================================================
const picker = { side: null, el: null, items: [], active: 0, back: null };
function pickerOptions(q) {
  q = q.trim().toLowerCase();
  const all = Array.from(state.ccy.values());
  if (!q) {
    const pop = MAJORS.filter(c => state.ccy.has(c)).map(c => state.ccy.get(c));
    return [{ group: 'Popular', list: pop }, { group: 'All currencies', list: all }];
  }
  const a = all.filter(c => c.code.toLowerCase().startsWith(q));
  const b = all.filter(c => !c.code.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [{ group: a.length + b.length ? 'Matches' : '', list: a.concat(b) }];
}
function renderPickerList(q) {
  const groups = pickerOptions(q), cur = picker.side === 'from' ? state.from : state.to, other = picker.side === 'from' ? state.to : state.from;
  picker.items = [];
  let html = '';
  groups.forEach(g => {
    if (g.group) html += `<li class="cxpop__g mono" role="presentation">${g.group}</li>`;
    g.list.forEach(c => {
      const i = picker.items.push(c.code) - 1;
      html += `<li class="cxopt${c.code === cur ? ' is-current' : ''}" role="option" id="cxo-${i}" data-i="${i}" aria-selected="${c.code === cur}">
        <span class="cxopt__sym">${esc(ccySym(c.code))}</span><b>${c.code}</b><span class="cxopt__n">${esc(c.name)}</span>
        ${c.code === other ? '<span class="cxopt__hint mono">swap</span>' : c.code === cur ? ICON.check : ''}</li>`;
    });
  });
  if (!picker.items.length) html = `<li class="cxpop__empty" role="presentation">No currency matches “${esc(q)}”.</li>`;
  const list = $('.cxpop__list', picker.el);
  list.innerHTML = html;
  list.scrollTop = 0;
  const ci = q ? 0 : Math.max(0, picker.items.indexOf(cur));
  setPickerActive(ci, false);
}
function setPickerActive(i, scroll = true) {
  if (!picker.items.length) return;
  picker.active = (i + picker.items.length) % picker.items.length;
  $$('.cxopt', picker.el).forEach(o => o.classList.toggle('is-active', Number(o.dataset.i) === picker.active));
  const a = $(`#cxo-${picker.active}`, picker.el);
  $('.cxpop__input', picker.el).setAttribute('aria-activedescendant', a ? a.id : '');
  if (a && scroll) a.scrollIntoView({ block: 'nearest' });
}
function openPicker(side) {
  if (picker.side) closePicker(false);
  const host = side === 'from' ? $('#cxFrom') : $('#cxTo');
  picker.side = side;
  const pop = document.createElement('div');
  pop.className = 'cxpop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', side === 'from' ? 'Choose the currency you have' : 'Choose the currency you want');
  pop.innerHTML = `<div class="cxpop__search">${ICON.search}<input class="cxpop__input" type="text" role="combobox" aria-expanded="true" aria-controls="cxlist" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search by name or code"><kbd class="mono">esc</kbd></div>
    <ul class="cxpop__list" id="cxlist" role="listbox" aria-label="Currencies"></ul>`;
  const back = document.createElement('div');
  back.className = 'cxback';
  document.body.appendChild(back);
  host.appendChild(pop);
  picker.el = pop; picker.back = back;
  $('.cx__btn', host).setAttribute('aria-expanded', 'true');
  host.classList.add('is-open');
  renderPickerList('');
  requestAnimationFrame(() => {
    pop.classList.add('is-on'); back.classList.add('is-on');
    const cur = $('.cxopt.is-current', pop);
    if (cur) cur.scrollIntoView({ block: 'center' });
    $('.cxpop__input', pop).focus({ preventScroll: true });
  });
  const input = $('.cxpop__input', pop);
  input.addEventListener('input', () => renderPickerList(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setPickerActive(picker.active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPickerActive(picker.active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setPickerActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setPickerActive(picker.items.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (picker.items.length) choose(picker.items[picker.active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(true); }
    else if (e.key === 'Tab') { closePicker(false); }
  });
  $('.cxpop__list', pop).addEventListener('click', e => {
    const o = e.target.closest('.cxopt');
    if (o) choose(picker.items[Number(o.dataset.i)]);
  });
  $('.cxpop__list', pop).addEventListener('pointermove', e => {
    const o = e.target.closest('.cxopt');
    if (o && Number(o.dataset.i) !== picker.active) setPickerActive(Number(o.dataset.i), false);
  });
  back.addEventListener('click', () => closePicker(false));
}
function closePicker(refocus) {
  if (!picker.side) return;
  const host = picker.side === 'from' ? $('#cxFrom') : $('#cxTo');
  const pop = picker.el, back = picker.back, btn = $('.cx__btn', host);
  btn.setAttribute('aria-expanded', 'false');
  host.classList.remove('is-open');
  pop.classList.remove('is-on'); back.classList.remove('is-on');
  setTimeout(() => { pop.remove(); back.remove(); }, 220);
  picker.side = null; picker.el = null; picker.back = null;
  if (refocus) btn.focus({ preventScroll: true });
}
function choose(code) {
  const side = picker.side;
  closePicker(true);
  if (!code) return;
  if (side === 'from') {
    if (code === state.from) return;
    setPair(code, code === state.to ? state.from : state.to, { swap: code === state.to });
  } else {
    if (code === state.to) return;
    setPair(code === state.from ? state.to : state.from, code, { swap: code === state.from });
  }
}

// =========================================================
// Intro
// =========================================================
async function runIntro(ready) {
  const overlay = $('.intro');
  if (!overlay) return ready;
  if (document.documentElement.classList.contains('no-intro')) { overlay.remove(); return ready; }
  document.body.classList.add('is-locked');
  overlay.classList.add('is-playing');
  const codes = $('#introCodes'), pct = $('#introPct');
  const pool = ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'CAD', 'AUD', 'CHF', 'CNY', 'SGD', 'AED', 'MXN', 'BRL', 'ZAR', 'SEK', 'KRW'];
  let done = false, left = false;
  const shuffle = setInterval(() => {
    const a = pool[(Math.random() * pool.length) | 0];
    let b = a; while (b === a) b = pool[(Math.random() * pool.length) | 0];
    codes.textContent = `${a} → ${b}`;
  }, 95);
  const t0 = performance.now();
  (function tick() {
    if (left) return;
    const v = done ? 100 : Math.min(86, Math.round((performance.now() - t0) / 2300 * 86));
    pct.textContent = String(v).padStart(3, '0');
    requestAnimationFrame(tick);
  })();
  const skip = new Promise(r => {
    overlay.addEventListener('click', r, { once: true });
    addEventListener('keydown', r, { once: true });
  });
  ready.then(() => { done = true; }, () => { done = true; });
  const minTime = new Promise(r => setTimeout(r, 2500));
  const skipped = await Promise.race([Promise.all([ready.catch(() => null), minTime]).then(() => false), skip.then(() => true)]);
  if (!done) await ready.catch(() => null);
  done = true;
  clearInterval(shuffle);
  if (state.from && state.to) codes.textContent = `${state.from} → ${state.to}`;
  overlay.classList.add('is-ready');
  pct.textContent = '100';
  if (!skipped) await new Promise(r => setTimeout(r, 520));   // let the chosen pair land before the curtain parts
  left = true;
  overlay.classList.add('is-leaving');
  document.body.classList.remove('is-locked');
  setTimeout(() => overlay.remove(), 1700);
  try { sessionStorage.setItem('fx_intro', '1'); } catch (e) { /* ignore */ }
  await new Promise(r => setTimeout(r, 520));
}

// =========================================================
// Global interactions
// =========================================================
function resolvedTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
const syncTheme = () => document.documentElement.setAttribute('data-resolved-theme', resolvedTheme());
function setMode(mode) {
  const pro = mode === 'pro';
  state.mode = mode;
  document.body.classList.toggle('is-pro', pro);
  $$('#modeSegs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  const el = $('#pro');
  el.inert = !pro; el.setAttribute('aria-hidden', String(!pro));
  store.set('fx_mode', mode);
  syncSegs($('.header'));
}
function parseNum(s) {
  const v = Number(String(s).replace(/,/g, '').replace(/[^\d.]/g, ''));
  return isFinite(v) ? v : NaN;
}

function bindGlobal() {
  syncTheme();
  const mq = matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', syncTheme);
  $('#themeBtn').addEventListener('click', () => {
    const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.add('theme-fade');
    document.documentElement.setAttribute('data-theme', next);
    store.set('fx_theme', next);
    syncTheme();
    setTimeout(() => document.documentElement.classList.remove('theme-fade'), 450);
  });

  setMode(store.get('fx_mode') === 'pro' ? 'pro' : 'plain');
  $$('#modeSegs button').forEach(b => b.addEventListener('click', () => {
    setMode(b.dataset.mode);
    if (b.dataset.mode === 'pro' && state.result) setTimeout(() => $('#pro').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }), 140);
  }));

  $$('.cx__btn').forEach(b => b.addEventListener('click', () => {
    const side = b.closest('.cx').dataset.side;
    if (picker.side === side) closePicker(true); else openPicker(side);
  }));
  $('#swapBtn').addEventListener('click', () => {
    const b = $('#swapBtn');
    b.dataset.r = String((Number(b.dataset.r) || 0) + 180);
    b.style.setProperty('--r', b.dataset.r + 'deg');
    setPair(state.to, state.from, { swap: true });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && picker.side) closePicker(true); });

  document.addEventListener('click', e => {
    const t = e.target;
    const to = t.closest('[data-to]');
    if (to) { if (to.dataset.to !== state.to) { setPair(state.from, to.dataset.to); scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); } return; }
    const w = t.closest('[data-pairfrom]');
    if (w) { setPair(w.dataset.pairfrom, w.dataset.pairto); scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); return; }
    const dl = t.closest('[data-deadline]');
    if (dl) {
      state.plan.deadline = Number(dl.dataset.deadline);
      $$('#dlSegs button').forEach(b => b.setAttribute('aria-checked', String(b === dl)));
      syncSegs($('#plan'));
      planChanged();
      return;
    }
    const rg = t.closest('[data-range]');
    if (rg) {
      state.range = rg.dataset.range; store.set('fx_range', state.range);
      $$('#rangeSegs button').forEach(b => b.setAttribute('aria-checked', String(b === rg)));
      syncSegs($('#history'));
      const c = $('#chart');
      buildChart();
      c.classList.remove('is-drawn'); void c.offsetWidth; c.classList.add('is-drawn');
      drawLine($('path.line', c), 900);
      return;
    }
    if (t.closest('#retryBtn')) { seriesCache.delete(state.from + '/' + state.to); const f = state.from, o = state.to; state.from = ''; setPair(f, o); return; }
    const rt = t.closest('#reasonToggle');
    if (rt) {
      const list = $('#reasonList'), open = list.classList.toggle('is-clamped') === false;
      rt.setAttribute('aria-expanded', String(open));
      rt.textContent = open ? 'Show fewer' : `Show all ${$$('li', list).length} reasons`;
    }
  });

  // radio groups: arrow keys
  document.addEventListener('keydown', e => {
    const r = e.target.closest && e.target.closest('[role="radio"]');
    if (!r || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const all = $$('[role="radio"]', r.parentElement), i = all.indexOf(r);
    const n = all[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + all.length) % all.length];
    e.preventDefault(); n.focus(); n.click();
  });

  let planTimer;
  document.addEventListener('input', e => {
    const id = e.target.id;
    if (id === 'amount') {
      const v = parseNum(e.target.value);
      if (!(v >= 0)) return;
      state.amount = Math.min(v, 1e12);
      store.set('fx_amount', state.amount);
      updateOuts();
      if (state.result) withInstant(() => { renderSteps(); renderDetails(); initReveal($('#steps'), true); initReveal($('#details'), true); });
    } else if (id === 'fee' || id === 'target') {
      clearTimeout(planTimer);
      planTimer = setTimeout(() => {
        const v = parseNum(e.target.value);
        if (id === 'fee') state.plan.fee = v > 0 ? Math.min(v, 50) : 0;
        else state.plan.target = v > 0 ? v : 0;
        planChanged();
      }, 450);
    }
  });
  document.addEventListener('focusout', e => {
    if (e.target.id === 'amount') e.target.value = state.amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (e.target.id === 'fee' && state.plan.fee) e.target.value = state.plan.fee;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && ['amount', 'fee', 'target'].includes(e.target.id)) e.target.blur(); });

  // magnetic swap button
  if (finePointer && !reduceMotion) {
    const b = $('#swapBtn');
    b.addEventListener('pointermove', e => {
      const r = b.getBoundingClientRect();
      b.style.setProperty('--tx', ((e.clientX - r.left - r.width / 2) * 0.28).toFixed(1) + 'px');
      b.style.setProperty('--ty', ((e.clientY - r.top - r.height / 2) * 0.28).toFixed(1) + 'px');
    });
    b.addEventListener('pointerleave', () => { b.style.setProperty('--tx', '0px'); b.style.setProperty('--ty', '0px'); });
  }

  // the dial leans toward the cursor
  if (finePointer && !reduceMotion) {
    const side = $('#heroSide');
    side.addEventListener('pointermove', e => {
      const d = $('.dial', side); if (!d) return;
      const r = d.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      d.style.setProperty('--ry', ((x - 0.5) * 7).toFixed(2) + 'deg');
      d.style.setProperty('--rx', ((0.5 - y) * 6).toFixed(2) + 'deg');
      d.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
      d.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
    });
    side.addEventListener('pointerleave', () => {
      const d = $('.dial', side); if (!d) return;
      d.style.setProperty('--ry', '0deg'); d.style.setProperty('--rx', '0deg');
    });
  }

  // header + scroll progress + hero parallax
  const header = $('.header'), bar = $('.loadbar i');
  let ticking = false;
  const onScroll = () => {
    const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    header.classList.toggle('is-scrolled', y > 16);
    bar.style.setProperty('--p', max > 0 ? (y / max).toFixed(4) : 0);
    if (!reduceMotion && finePointer) {
      const side = $('#heroSide');
      if (side && y < innerHeight * 1.4 && innerWidth >= 980) side.style.transform = `translate3d(0, ${Math.min(y * 0.07, 46).toFixed(1)}px, 0)`;
      else if (side) side.style.transform = '';
    }
    ticking = false;
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  onScroll();

  let rt, lastW = innerWidth;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      syncSegs();
      if (innerWidth === lastW) return;
      lastW = innerWidth;
      buildChart(); buildHist(); hydrateSparks();
      const c = $('#chart'); if (c && c.classList.contains('is-drawn')) c.classList.add('is-drawn');
    }, 160);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => syncSegs());
  document.addEventListener('visibilitychange', () => document.body.classList.toggle('is-paused', document.hidden));
}

// =========================================================
// Boot
// =========================================================
(async function boot() {
  bindGlobal();
  const valid = c => /^[A-Za-z]{3}$/.test(c || '') ? c.toUpperCase() : null;
  let from = valid(params.get('from')) || valid(store.get('fx_from')) || 'USD';
  let to = valid(params.get('to')) || valid(store.get('fx_to')) || 'INR';
  if (from === to) { to = from === 'USD' ? 'INR' : 'USD'; }
  const amt = Number(store.get('fx_amount'));
  if (amt > 0 && isFinite(amt)) state.amount = amt;
  if (RANGES[store.get('fx_range')]) state.range = store.get('fx_range');

  state.from = ''; // force first load
  const ccy = loadCurrencies().then(() => {
    // a code the service does not know cannot be analysed: fall back before fetching
    if (!state.ccy.has(from)) from = 'USD';
    if (!state.ccy.has(to) || to === from) to = from === 'INR' ? 'USD' : 'INR';
  });
  const ready = ccy.then(() => setPair(from, to, { silent: true }));
  loadSheet().then(() => {
    if (state.from && !store.get(planKey()) && state.sheet.some(s => s.from === state.from && s.to === state.to)) {
      loadPlan();
      if (state.result) { analyse(); renderPair({ instant: true, keepLists: true }); }
    }
    renderWatch();
    hydrateSparks($('#watch'));
    initReveal($('#watch'));
  });
  await runIntro(ready);
  await ready;
  updateCombos();
  renderPair();
})();

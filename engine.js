/* =========================================================
   FX Timing Helper - statistics + decision engine
   Browser port of the logic in Code.gs (same formulas, same rules),
   so any From -> To pair can be analysed live.
   Works in the browser (window.FXEngine) and in Node (module.exports).
   ========================================================= */
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.FXEngine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_POINTS = 30;      // fewer clean points than this = cannot analyse
  const STALE_DAYS = 4;       // older than this = low confidence (covers a weekend + 1 holiday)
  const OUTLIER_K = 6;        // robust sigmas for the spike rule
  const FLAT_RANGE_PCT = 0.3; // 1-year range below this = pegged / flat pair

  // ---------- math ----------
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  function variance(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
  }
  const std = a => Math.sqrt(variance(a));
  function quantile(a, q) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  const median = a => quantile(a, 0.5);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  function round(x, dp) {
    if (x == null || typeof x !== 'number' || !isFinite(x)) return null;
    const f = Math.pow(10, dp);
    return Math.round(x * f) / f;
  }
  function emaSeries(x, period) {
    const k = 2 / (period + 1), out = [x[0]];
    for (let i = 1; i < x.length; i++) out.push(x[i] * k + out[i - 1] * (1 - k));
    return out;
  }
  function rsi(x, period) {
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
  function linreg(y) {
    const m = y.length;
    if (m < 3) return null;
    const xm = (m - 1) / 2, ym = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < m; i++) {
      sxy += (i - xm) * (y[i] - ym); sxx += (i - xm) * (i - xm); syy += (y[i] - ym) * (y[i] - ym);
    }
    const slope = sxx ? sxy / sxx : 0;
    return { slope: slope, r2: syy && sxx ? (sxy * sxy) / (sxx * syy) : 0 };
  }
  function varianceRatio(ret, q) {
    if (ret.length < q * 4) return null;
    const v1 = variance(ret);
    if (!v1) return null;
    const sums = [];
    for (let i = 0; i + q <= ret.length; i++) {
      let s = 0;
      for (let j = i; j < i + q; j++) s += ret[j];
      sums.push(s);
    }
    return variance(sums) / (q * v1);
  }
  function autocorr1(x) {
    if (x.length < 3) return null;
    const m = mean(x);
    let num = 0, den = 0;
    for (let i = 0; i < x.length; i++) {
      den += (x[i] - m) * (x[i] - m);
      if (i > 0) num += (x[i] - m) * (x[i - 1] - m);
    }
    return den ? num / den : null;
  }

  // ---------- dates / text ----------
  function parseDay(s) {
    const p = String(s).slice(0, 10).split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]);
  }
  const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
  const isWeekend = d => { const wd = new Date(parseDay(d)).getUTCDay(); return wd === 0 || wd === 6; };
  function humanDays(d) {
    if (d === 1) return '1 day';
    if (d < 60) return d + ' days';
    if (d < 730) return Math.round(d / 30.4) + ' months';
    return Math.round(d / 365) + ' years';
  }
  function sgn(x, dp) {
    if (x == null || !isFinite(x)) return 'n/a';
    return (x >= 0 ? '+' : '') + Number(x).toFixed(dp == null ? 1 : dp);
  }

  // ---------- 1. clean ----------
  // rows: [{date:'yyyy-MM-dd', rate:Number}]
  function clean(rows) {
    let invalid = 0, duplicates = 0, weekends = 0;
    const byDate = {};
    (rows || []).forEach(r => {
      const d = String(r.date == null ? '' : r.date).slice(0, 10);
      const rate = Number(r.rate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isFinite(rate) || rate <= 0) { invalid++; return; }
      // The API publishes thin weekend prints; the statistics assume trading days (252 / year).
      if (isWeekend(d)) { weekends++; return; }
      if (byDate[d] !== undefined) duplicates++;
      byDate[d] = rate;
    });
    const series = Object.keys(byDate).sort().map(d => ({ date: d, rate: byDate[d], outlier: false }));

    // Spike rule: jump INTO a point and jump OUT of it both extreme and opposite => bad print.
    if (series.length > 20) {
      const ret = [];
      for (let i = 1; i < series.length; i++) ret.push(Math.log(series[i].rate / series[i - 1].rate));
      const med = median(ret);
      const sigma = 1.4826 * median(ret.map(x => Math.abs(x - med)));
      if (sigma > 0) {
        const lim = OUTLIER_K * sigma;
        for (let i = 1; i < series.length - 1; i++) {
          const a = ret[i - 1] - med, b = ret[i] - med;
          if (Math.abs(a) > lim && Math.abs(b) > lim && a * b < 0) series[i].outlier = true;
        }
        const lastIn = ret[ret.length - 1] - med;
        if (Math.abs(lastIn) > 2 * lim) series[series.length - 1].outlier = true;
      }
    }
    return { series: series, invalid: invalid, duplicates: duplicates, weekends: weekends,
             outliers: series.filter(s => s.outlier).length };
  }

  // ---------- 2. statistics ----------
  // plan: { higherIsBetter (default true), deadlineDays, feePct, targetRate, base, quote }
  function compute(series, plan, today) {
    plan = plan || {};
    const good = series.filter(s => !s.outlier);
    const n = good.length;
    if (n < MIN_POINTS) return null;

    const d = good.map(s => s.date);
    const r = good.map(s => s.rate);
    const dir = plan.higherIsBetter === false ? -1 : 1;
    const last = r[n - 1];
    const tail = k => r.slice(Math.max(0, n - k));
    const favPct = k => { const w = tail(k); return w.filter(x => dir * x <= dir * last).length / w.length; };
    const rawPct = k => { const w = tail(k); return w.filter(x => x <= last).length / w.length; };

    const w30 = tail(30), w90 = tail(90), w252 = tail(252);
    const mean30 = mean(w30), mean90 = mean(w90), std30 = std(w30), std90 = std(w90);
    const mm = w => [Math.min.apply(null, w), Math.max.apply(null, w)];
    const [min30, max30] = mm(w30), [min90, max90] = mm(w90), [min252, max252] = mm(w252);
    const pct30 = favPct(30), pct90 = favPct(90), pct252 = favPct(252);
    let better1y = 0;
    for (let i = Math.max(0, n - 252); i < n - 1; i++) if (dir * r[i] > dir * last) better1y++;
    let daysSinceBetter = null;
    for (let i = n - 2; i >= 0; i--) {
      if (dir * r[i] > dir * last) { daysSinceBetter = daysBetween(d[i], d[n - 1]); break; }
    }
    const z30 = std30 > 0 ? (last - mean30) / std30 : 0;
    const z90 = std90 > 0 ? (last - mean90) / std90 : 0;
    const best90 = dir > 0 ? max90 : min90;
    const best252 = dir > 0 ? max252 : min252;

    const ema12 = emaSeries(r, 12), ema26 = emaSeries(r, 26);
    const macdS = r.map((_, i) => ema12[i] - ema26[i]);
    const sigS = emaSeries(macdS, 9);
    const macd = macdS[n - 1], macdSig = sigS[n - 1], hist = macd - macdSig;
    const sma7 = mean(tail(7)), sma30 = mean30, sma90 = mean90;

    const rsi14 = rsi(r, 14);
    const w20 = tail(20), m20 = mean(w20), s20 = std(w20);
    const up = m20 + 2 * s20, lo = m20 - 2 * s20;
    const pctB = up > lo ? (last - lo) / (up - lo) : 0.5;
    const bandwidth = m20 ? (up - lo) / m20 : 0;

    const logs = r.map(Math.log);
    const lr30 = linreg(logs.slice(-30)), lr90 = linreg(logs.slice(-90));

    const ret = [];
    for (let i = 1; i < n; i++) ret.push(logs[i] - logs[i - 1]);
    const ret30 = ret.slice(-30), ret90 = ret.slice(-90), ret252 = ret.slice(-252);
    const sd30 = std(ret30), sd90 = std(ret90);
    const vol30 = sd30 * Math.sqrt(252) * 100, vol90 = sd90 * Math.sqrt(252) * 100;
    const chg = k => n > k ? (last / r[n - 1 - k] - 1) * 100 : null;
    const exp7 = sd30 * Math.sqrt(5) * 100;

    const vr = varianceRatio(ret252, 5);
    const ac = autocorr1(ret252);
    const regime = vr == null ? 'unknown' : vr < 0.85 ? 'mean-reverting' : vr > 1.15 ? 'trending' : 'random-like';

    const dl = Number(plan.deadlineDays) > 0 ? Number(plan.deadlineDays) : 0;
    const h = dl > 0 ? clamp(Math.round(dl * 5 / 7), 1, 60) : 10;
    const target = Number(plan.targetRate) > 0 ? Number(plan.targetRate) : 0;
    const fee = Number(plan.feePct) > 0 ? Number(plan.feePct) : 0;
    const targetGap = target > 0 ? dir * (target / last - 1) * 100 : null;
    const ws = waitStats(r, h, dir, targetGap);
    const edge = historicalEdge(r, dir, pct90);

    const favBoll = clamp(dir > 0 ? pctB : 1 - pctB, 0, 1);
    const favZ90 = dir * z90;
    const favRsi = rsi14 == null ? 50 : (dir > 0 ? rsi14 : 100 - rsi14);
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
    const feeRatio = fee > 0 && exp7 > 0 ? fee / exp7 : null;

    // ----- extra statistics for the UI (they never change the level score) -----
    const perfOf = k => n > k ? round(dir * (last / r[n - 1 - k] - 1) * 100, 2) : null;
    const perf = [['1W', 5], ['1M', 21], ['3M', 63], ['6M', 126], ['1Y', 252]].map(x => ({ k: x[0], v: perfOf(x[1]) }));
    perf.push({ k: 'All', v: round(dir * (last / r[0] - 1) * 100, 2) });

    const curve = waitCurve(r, dir, pct90, dl > 0 ? h : 60, dl > 0 ? h : null);
    let bestWait = null;
    let topWait = null;
    curve.forEach(c => { if (c.p50 > 0.02 && c.prob >= 0.5 && (!topWait || c.p50 > topWait.p50)) topWait = c; });
    // "Wait at least": the shortest window that already captured most (60%) of the best typical gain.
    if (topWait) bestWait = curve.filter(c => c.prob >= 0.5 && c.p50 >= 0.6 * topWait.p50)[0] || topWait;

    // Early trigger: the rate that puts the level back above average, but never a rate that
    // history says is out of reach. If that level was rarely touched in time, fall back to an
    // improvement that was reached in roughly one window out of three.
    let trigLevel = quantile(w90, dir > 0 ? 0.6 : 0.4);
    let trigGap = dir * (trigLevel / last - 1) * 100;
    let trigKind = 'level', trig = null;
    if (trigGap > 0.02) {
      const H = dl > 0 ? h : 20;
      const reach = reachGap(r, dir, H, 0.65);
      if (reach != null && reach < trigGap) { trigGap = reach; trigLevel = last * (1 + dir * reach / 100); trigKind = 'reach'; }
      trig = trigGap > 0.05 ? touchStats(r, dir, trigGap, H) : null;
    }

    const fav = ret.map(x => dir * x * 100);
    const favY = fav.slice(-252);
    const wkStart = Math.max(1, n - 504);
    const weekdays = [1, 2, 3, 4, 5].map(wd => {
      const xs = [];
      for (let i = wkStart; i < n; i++) if (new Date(parseDay(d[i])).getUTCDay() === wd) xs.push(fav[i - 1]);
      const m = mean(xs), sdv = std(xs);
      return { d: ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][wd], mean: round(m, 3), n: xs.length,
               t: sdv > 0 && xs.length > 1 ? round(m / (sdv / Math.sqrt(xs.length)), 2) : 0 };
    });
    const sgnLast = fav.length ? Math.sign(fav[fav.length - 1]) : 0;
    let streak = 0;
    for (let i = fav.length - 1; i >= 0 && sgnLast !== 0 && Math.sign(fav[i]) === sgnLast; i--) streak++;
    let hiI = n - 1, loI = n - 1;
    for (let i = Math.max(0, n - 252); i < n; i++) { if (r[i] > r[hiI]) hiI = i; if (r[i] < r[loI]) loI = i; }
    const range252Pct = (max252 - min252) / mean(w252) * 100;
    const pos = (v, a, b) => b > a ? round((v - a) / (b - a), 3) : 0.5;

    return {
      _dir: dir, _favPct90: pct90, _favPct252: pct252, _favBoll: favBoll, _favZ90: favZ90, _favRsi: favRsi,
      _rawPct90: rawPct(90), _mom30raw: chg(30), _n252: w252.length,
      _flat: w252.length >= 60 && range252Pct < FLAT_RANGE_PCT,

      pair: (plan.base || '') + '/' + (plan.quote || ''), base: plan.base || '', quote: plan.quote || '',
      higher_is_better: dir > 0, deadline_days: dl || null,
      rate: last, rate_date: d[n - 1], data_age_days: today ? daysBetween(d[n - 1], today) : 0, points: n,
      prev_rate: n > 1 ? r[n - 2] : null,

      signals_good: votes.filter(v => v[1]).length, signals_total: votes.length,
      signals_detail: votes.map(v => v[0] + '=' + (v[1] ? 1 : 0)).join(';'),

      pct30: round(pct30, 3), pct90: round(pct90, 3), pct252: round(pct252, 3),
      rank_1y: better1y + 1, days_since_better: daysSinceBetter,
      history_days: daysBetween(d[0], d[n - 1]), first_date: d[0],
      z30: round(z30, 2), z90: round(z90, 2),

      mean30: mean30, mean90: mean90, std30: std30,
      min30: min30, max30: max30, min90: min90, max90: max90, min252: min252, max252: max252,
      range_pos30: pos(last, min30, max30), range_pos90: pos(last, min90, max90), range_pos252: pos(last, min252, max252),
      range252_pct: round(range252Pct, 2),
      vs_mean30_pct: round(vsMean30, 2),
      vs_best90_pct: round(dir * (last / best90 - 1) * 100, 2),
      vs_best252_pct: round(dir * (last / best252 - 1) * 100, 2),

      sma7: sma7, sma30: sma30, sma90: sma90,
      ema12: ema12[n - 1], ema26: ema26[n - 1],
      macd: macd, macd_signal: macdSig, macd_hist: hist,
      momentum: dir * hist > 0 ? 'favorable' : 'unfavorable',

      rsi14: round(rsi14, 1), boll_pctB: round(pctB, 3), boll_bandwidth: round(bandwidth, 4),

      trend_slope30_pct_day: lr30 ? round(dir * lr30.slope * 100, 4) : null,
      trend_r2_30: lr30 ? round(lr30.r2, 3) : null,
      trend_slope90_pct_day: lr90 ? round(dir * lr90.slope * 100, 4) : null,
      trend_r2_90: lr90 ? round(lr90.r2, 3) : null,

      vol30_ann_pct: round(vol30, 2), vol_ratio: vol90 > 0 ? round(vol30 / vol90, 2) : null,
      avg_daily_move_pct: round(mean(ret30.map(Math.abs)) * 100, 3),
      mom1_pct: round(chg(1), 3), mom7_pct: round(chg(7), 3), mom30_pct: round(chg(30), 3),
      exp_move7_pct: round(exp7, 2),

      variance_ratio5: round(vr, 3), autocorr1: round(ac, 3), regime: regime,

      wait_horizon_obs: h, wait_windows: ws.obs,
      wait_p05_pct: round(ws.p05, 2), wait_p50_pct: round(ws.p50, 2), wait_p95_pct: round(ws.p95, 2),
      wait_prob_better: round(ws.prob, 3), wait_hist: ws.hist,
      wait_dip_p50_pct: round(ws.dipP50, 2), wait_dip_p05_pct: round(ws.dipP05, 2),
      wait_mean_pct: round(ws.mean, 2),
      wait_curve: curve, wait_best: bestWait,
      trigger_rate: trig ? trigLevel : null, trigger_gap_pct: trig ? round(trigGap, 2) : null,
      trigger_kind: trig ? trigKind : null,
      trigger_prob: trig ? round(trig.prob, 3) : null, trigger_days: trig ? trig.days : null, trigger_horizon: trig ? trig.H : null,
      perf: perf, weekdays: weekdays,
      streak_len: streak, streak_dir: sgnLast > 0 ? 'up' : sgnLast < 0 ? 'down' : 'flat',
      daily_var95_pct: favY.length >= 60 ? round(quantile(favY, 0.05), 2) : null,
      daily_up95_pct: favY.length >= 60 ? round(quantile(favY, 0.95), 2) : null,
      high252_date: d[hiI], low252_date: d[loI],

      fee_pct: fee || null, fee_vs_weekly_move: round(feeRatio, 2),
      target_rate: target || null, target_gap_pct: round(targetGap, 2), target_prob: round(ws.targetProb, 3),

      base_strength_pct90: null, base_strong_count: null, base_peers: null, rel_mom30_vs_basket: null,

      edge_n: edge.n, edge_bucket_mean7: round(edge.bucketMean, 3), edge_base_mean7: round(edge.baseMean, 3),
      edge_bucket_win: round(edge.bucketWin, 3), edge_base_win: round(edge.baseWin, 3),

      outliers_flagged: series.length - n
    };
  }

  function waitStats(r, h, dir, gap) {
    const chg = [], best = [], worst = [];
    for (let i = 0; i + h < r.length; i++) {
      chg.push(dir * (r[i + h] / r[i] - 1) * 100);
      let w = Infinity;
      for (let j = 1; j <= h; j++) w = Math.min(w, dir * (r[i + j] / r[i] - 1) * 100);
      worst.push(w);
      if (gap != null && gap > 0) {
        let b = -Infinity;
        for (let j = 1; j <= h; j++) b = Math.max(b, dir * (r[i + j] / r[i] - 1) * 100);
        best.push(b);
      }
    }
    const targetProb = gap == null ? null : gap <= 0 ? 1 : (best.length ? best.filter(b => b >= gap).length / best.length : null);
    if (chg.length < 20) return { obs: chg.length, p05: null, p50: null, p95: null, prob: null, targetProb: targetProb, hist: null, dipP50: null, dipP05: null, mean: null };

    // Histogram of outcomes (symmetric around 0 so "better" and "worse" are comparable).
    const m = Math.max(Math.abs(quantile(chg, 0.005)), Math.abs(quantile(chg, 0.995)));
    let hist = null;
    if (m > 0) {
      const B = 24, bins = new Array(B).fill(0);
      chg.forEach(x => { bins[clamp(Math.floor((x + m) / (2 * m) * B), 0, B - 1)]++; });
      hist = { m: m, bins: bins, total: chg.length };
    }
    return {
      obs: chg.length,
      p05: quantile(chg, 0.05), p50: quantile(chg, 0.5), p95: quantile(chg, 0.95),
      prob: chg.filter(x => x > 0).length / chg.length,
      targetProb: targetProb, hist: hist,
      dipP50: quantile(worst, 0.5), dipP05: quantile(worst, 0.05), mean: mean(chg)
    };
  }

  // What happened after waiting h trading days, starting from days that looked like today
  // (similar 90-day position). Falls back to all days when there are too few similar ones.
  function waitCurve(r, dir, pctNow, maxH, exact) {
    const hs = [2, 5, 10, 15, 20, 30, 45, 60].filter(x => x <= maxH);
    if (exact && hs.indexOf(exact) < 0) hs.push(exact);
    hs.sort((a, b) => a - b);
    const sim = [];
    for (let i = 89; i < r.length; i++) {
      const v = dir * r[i];
      let c = 0;
      for (let j = i - 89; j <= i; j++) if (dir * r[j] <= v) c++;
      if (Math.abs(c / 90 - pctNow) <= 0.15) sim.push(i);
    }
    return hs.map(h => {
      let use = [], conditional = true;
      sim.forEach(i => { if (i + h < r.length) use.push(dir * (r[i + h] / r[i] - 1) * 100); });
      if (use.length < 40) {
        use = []; conditional = false;
        for (let i = 0; i + h < r.length; i++) use.push(dir * (r[i + h] / r[i] - 1) * 100);
      }
      if (use.length < 20) return null;
      return { h: h, n: use.length, conditional: conditional,
               prob: round(use.filter(x => x > 0).length / use.length, 3),
               p50: round(quantile(use, 0.5), 2), mean: round(mean(use), 2),
               p05: round(quantile(use, 0.05), 2), p95: round(quantile(use, 0.95), 2) };
    }).filter(Boolean);
  }

  // The improvement that the best point of an H-day window exceeded in (1 - q) of all windows.
  function reachGap(r, dir, H, q) {
    const best = [];
    for (let i = 0; i + H < r.length; i++) {
      let b = -Infinity;
      for (let j = 1; j <= H; j++) b = Math.max(b, dir * (r[i + j] / r[i] - 1) * 100);
      best.push(b);
    }
    return best.length >= 20 ? quantile(best, q) : null;
  }

  // How often, and how quickly, the rate improved by at least `gap` percent within H trading days.
  function touchStats(r, dir, gap, H) {
    const first = [];
    let total = 0;
    for (let i = 0; i + H < r.length; i++) {
      total++;
      for (let j = 1; j <= H; j++) if (dir * (r[i + j] / r[i] - 1) * 100 >= gap) { first.push(j); break; }
    }
    if (total < 20) return null;
    return { prob: first.length / total, days: first.length ? Math.round(median(first)) : null, H: H };
  }

  function historicalEdge(r, dir, pctNow) {
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
      bucketMean: ok ? mean(bucket) : null, baseMean: all.length ? mean(all) : null,
      bucketWin: ok ? win(bucket) : null, baseWin: all.length ? win(all) : null
    };
  }

  // ---------- 3. decision ----------
  function decide(st) {
    const score = Math.round(100 * (
      0.40 * st._favPct90 +
      0.25 * st._favPct252 +
      0.20 * st._favBoll +
      0.15 * clamp((st._favZ90 + 2) / 4, 0, 1)));

    const dl = st.deadline_days || 0;
    let pct, label, override = '';
    if (st.target_gap_pct != null && st.target_gap_pct <= 0) {
      pct = 100; label = 'CONVERT NOW'; override = 'Your target rate has been reached.';
    } else if (dl > 0 && dl <= 2) {
      pct = 100; label = 'CONVERT NOW'; override = 'Your deadline is within 2 days.';
    } else if (st._flat) {
      pct = 100; label = 'NO TIMING NEEDED';
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
    const tail = st._flat ? 'this pair barely moves'
      : dsb == null ? 'best rate in the available history'
      : dsb >= 30 ? 'best rate in ' + humanDays(dsb)
      : 'a better rate was seen ' + humanDays(dsb) + ' ago';

    const P = x => Math.round(x * 100) + '%';
    const s = [];
    if (st._flat) {
      s.push('This pair has moved only ' + st.range252_pct + '% over the last year, so it is effectively pegged or flat. ' +
             'Timing makes almost no difference: convert whenever it suits you and focus on your provider\'s fee instead.');
    }
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
      s.push('If you wait ' + st.wait_horizon_obs + (st.wait_horizon_obs === 1 ? ' trading day' : ' trading days') +
             ', history says the rate ended better for you ' + P(st.wait_prob_better) + ' of the time; a bad case is ' +
             sgn(st.wait_p05_pct) + '% and a good case is ' + sgn(st.wait_p95_pct) + '%.');
    }
    if (st.regime === 'mean-reverting') s.push('This pair has tended to snap back toward its average.');
    if (st.regime === 'trending') s.push('This pair has tended to keep moving in the same direction for a while.');
    if (st.regime === 'random-like') s.push('This pair has behaved close to a random walk, so timing gains are uncertain.');
    if (st.base_peers) {
      s.push(st.base + ' is near its 90-day high against ' + st.base_strong_count + ' of ' + st.base_peers +
             ' major currencies.');
      if (st.rel_mom30_vs_basket != null && Math.abs(st.rel_mom30_vs_basket) >= 1.5) {
        s.push('Over 30 days this pair moved ' + sgn(st.rel_mom30_vs_basket) + ' points vs. the basket, so the move is specific to ' +
               st.quote + '.');
      }
    }
    if ((st.vol_ratio || 0) > 1.5) s.push('Volatility is elevated (' + st.vol_ratio + 'x its 90-day level); moves may be larger than usual.');
    if (st.exp_move7_pct > 0) s.push('A typical one-week move is about +/-' + st.exp_move7_pct + '%.');
    if (st.fee_vs_weekly_move != null) {
      s.push(st.fee_vs_weekly_move >= 1
        ? 'Your provider cost (' + st.fee_pct + '%) is ' + st.fee_vs_weekly_move + 'x a typical weekly move, so comparing providers may save more than timing.'
        : 'Your provider cost (' + st.fee_pct + '%) is smaller than a typical weekly move.');
    }
    if (st.target_rate) {
      s.push(st.target_gap_pct <= 0 ? 'Your target is reached.'
        : 'Your target needs ' + st.target_gap_pct + '% more; historically reached within the horizon ' +
          (st.target_prob == null ? 'n/a' : P(st.target_prob)) + ' of the time.');
    }
    if (st.edge_bucket_mean7 != null && st.edge_base_mean7 != null) {
      const diff = st.edge_bucket_mean7 - st.edge_base_mean7;
      let msg = 'On ' + st.edge_n + ' past days at a similar level, the next week moved ' + sgn(st.edge_bucket_mean7, 2) +
                '% for you on average vs. ' + sgn(st.edge_base_mean7, 2) + '% on all days';
      if (st._favPct90 >= 0.6 && diff < -0.05) msg += ', so good levels like this have tended to fade (supports converting now).';
      else if (st._favPct90 <= 0.4 && diff > 0.05) msg += ', so weak levels like this have tended to recover (supports waiting).';
      else msg += ', so the level alone gave no clear edge; splitting is a sensible hedge.';
      s.push(msg);
    }
    // ----- advice: what to do, when, and in how many parts -----
    const calDays = x => Math.max(1, Math.round(x * 7 / 5));
    const span = x => x <= 4 ? x + ' days' : x <= 9 ? 'a week' : x <= 17 ? 'two weeks' : x <= 24 ? 'three weeks'
      : x <= 37 ? 'a month' : x <= 52 ? 'six weeks' : Math.round(x / 30) + ' months';
    const win = dl > 0 ? dl : 21;
    const bw = st.wait_best;
    let kind = label === 'CONVERT NOW' ? 'now' : label.indexOf('MOST') >= 0 ? 'most' : label.indexOf('HALF') >= 0 ? 'half'
      : label.indexOf('SPLIT') >= 0 ? 'third' : label === 'NO TIMING NEEDED' ? 'any' : 'wait';
    if (kind === 'wait' && !bw) kind = 'stagger';   // a poor level, but history does not favour waiting it out
    let waitDays = null, nowPct = pct;
    const before = x => Math.max(1, dl > 0 ? Math.min(x, dl - 1) : x);
    const trigTxt = st.trigger_rate ? ' Convert sooner if the rate reaches the trigger.' : '';
    const steps = [];
    if (kind === 'now') steps.push({ day: 0, pct: 100, text: override || 'Convert the full amount. Today is one of the better days you are likely to get.' });
    else if (kind === 'any') steps.push({ day: 0, pct: 100, text: 'Convert whenever suits you. Spend the effort on finding a cheaper provider.' });
    else if (kind === 'most') {
      steps.push({ day: 0, pct: 75, text: 'Convert three quarters today while the level is good.' });
      steps.push({ day: before(Math.round(win / 2)), pct: 25, text: 'Convert the rest.' + trigTxt });
    } else if (kind === 'half') {
      steps.push({ day: 0, pct: 50, text: 'Convert half today. The level is good and still moving your way.' });
      steps.push({ day: before(Math.round(win / 2)), pct: 50, text: 'Convert the other half.' + trigTxt });
    } else if (kind === 'third' || kind === 'stagger') {
      nowPct = 33;
      steps.push({ day: 0, pct: 33, text: kind === 'stagger'
        ? 'Convert a third today. The level is poor, but history does not favour waiting for a rebound from here.'
        : 'Convert a third today. The level is average, so spread the risk.' });
      steps.push({ day: before(Math.round(win / 3)), pct: 33, text: 'Convert the second third.' + trigTxt });
      steps.push({ day: before(Math.round(win * 2 / 3)), pct: 34, text: 'Convert the final third.' });
    } else {
      waitDays = calDays(bw.h);
      if (dl > 0) waitDays = Math.max(1, Math.min(waitDays, dl - 2));
      steps.push({ day: 0, pct: 0, text: 'Hold. Today is a poor level for you.' });
      steps.push({ day: waitDays, pct: null, text: 'Look again. Convert if the score has climbed above 60.' + trigTxt });
      steps.push({ day: dl > 0 ? Math.max(waitDays + 1, dl - 1) : waitDays * 2, pct: 100,
                   text: dl > 0 ? 'Convert whatever is left. Your deadline is next.' : 'If nothing has improved, stop waiting and split the amount in thirds.' });
    }
    const adviceText = kind === 'now' ? 'Convert now.' : kind === 'most' ? 'Convert most of it now.' : kind === 'half' ? 'Convert half now.'
      : kind === 'third' ? 'Split it. A third now.' : kind === 'stagger' ? 'Don\'t wait. Stagger it.' : kind === 'any' ? 'Any day works.'
      : 'Wait at least ' + span(waitDays) + '.';
    if (kind === 'wait') {
      s.push('From ' + (bw.conditional ? 'days at a similar level' : 'any day') + ', waiting at least ' + span(waitDays) + ' (' + bw.h +
             ' trading days) ended better ' + P(bw.prob) + ' of the time, with a typical gain of ' + sgn(bw.p50, 2) + '%.');
    }
    if (kind === 'stagger') s.push('Waiting has not reliably paid off from levels like this, so converting in equal parts is the safer plan.');
    if (st.trigger_rate && kind !== 'now' && kind !== 'any') {
      s.push('A sensible trigger is a rate ' + st.trigger_gap_pct + '% better than today' +
             (st.trigger_kind === 'level' ? ', which would lift the level back above average. ' : ', a realistic improvement for this window. ') +
             'It was reached within ' + st.trigger_horizon + ' trading days ' + P(st.trigger_prob) + ' of the time' +
             (st.trigger_days ? ', typically after ' + st.trigger_days + '.' : '.'));
    }
    if (override) s.push('Override: ' + override);

    const out = Object.assign({}, st);
    out.advice = { kind: kind, text: adviceText, now_pct: nowPct, wait_days: waitDays, steps: steps };
    out.score = score;
    out.decision = label;
    out.headline = label + ' - ' + tail;
    out.headline_tail = tail;
    out.convert_now_pct = pct;
    out.confidence = confidence;
    out.reason = s.join(' ');
    out.reasons = s;
    out.override = override;
    return out;
  }

  return {
    MIN_POINTS: MIN_POINTS, STALE_DAYS: STALE_DAYS,
    clean: clean, compute: compute, decide: decide,
    util: { mean: mean, std: std, quantile: quantile, clamp: clamp, round: round, daysBetween: daysBetween,
            isWeekend: isWeekend, humanDays: humanDays, parseDay: parseDay }
  };
});

// Client-side port of Adaptive Probability Tunnel v0.8 (physics_engine.py +
// tunnel_engine.py). Same equations, same five-force structure, same
// Monte-Carlo propagation. Differences from the Python original, and why:
//
//  - Data source is Binance (spot + USDT-M futures) instead of OKX. OKX's
//    REST API does not send CORS headers, so a static GitHub Pages site
//    cannot call it directly from the browser; Binance's public market
//    endpoints do (same reason the existing ETH Radar PWA already uses
//    Binance).
//  - "hist"/"anchor" persistence uses localStorage instead of the
//    Python side's SQLite file, since there is no server process here.
//    That means state is per-browser, not shared across devices.
//  - The LPPLS grid search is smaller (3x3x3 instead of 5x4x4) purely for
//    browser CPU budget; the regression itself (normal equations /
//    Gauss-Jordan) is the same closed-form fit as numpy's lstsq.
//  - Monte-Carlo path count defaults to 1500 instead of 2500 for the same
//    reason; the SDE (dv, dlogP) is identical.

function combineFive(vals) {
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return { force: Math.tanh(mean / 0.55), disagreement: Math.sqrt(variance) };
}

function latentForce(hist, current, alpha = 0.16) {
  const vals = hist.slice(-16).map(x => x.physics_force_raw ?? 0);
  vals.push(current);
  let y = vals[0];
  for (let i = 1; i < vals.length; i++) y = (1 - alpha) * y + alpha * vals[i];
  return clip(y, -1.2, 1.2);
}

// --- tiny least squares (normal equations + Gauss-Jordan) ---------------
function solveLstsq(X, y) {
  const n = X.length, k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let c = col; c <= k; c++) M[col][c] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= k; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(row => row[k]);
}

function lpplCriticality(prices) {
  const y = prices.filter(p => p > 0).map(Math.log);
  if (y.length < 80) return { score: 0, fit: 0 };
  const yy = y.slice(-160);
  const n = yy.length;
  const t = Array.from({ length: n }, (_, i) => i);
  const X0 = t.map(ti => [1, ti]);
  const b0 = solveLstsq(X0, yy);
  const sse0 = yy.reduce((s, yi, i) => s + (yi - (b0[0] + b0[1] * t[i])) ** 2, 0) + 1e-15;
  let best = null;
  for (const tcAdd of [16, 32, 48]) {
    const tc = (n - 1) + tcAdd;
    for (const m of [0.3, 0.5, 0.7]) {
      const tau = t.map(ti => tc - ti);
      const f = tau.map(v => Math.pow(v, m));
      const lt = tau.map(Math.log);
      for (const w of [6, 9, 12]) {
        const X = t.map((_, i) => [1, f[i], f[i] * Math.cos(w * lt[i]), f[i] * Math.sin(w * lt[i])]);
        let b, sse;
        try {
          b = solveLstsq(X, yy);
          sse = yy.reduce((s, yi, i) => {
            const pred = X[i][0] * b[0] + X[i][1] * b[1] + X[i][2] * b[2] + X[i][3] * b[3];
            return s + (yi - pred) ** 2;
          }, 0);
        } catch { continue; }
        if (!best || sse < best.sse) best = { sse, tcAdd, m, w };
      }
    }
  }
  if (!best) return { score: 0, fit: 0 };
  const improvement = clip(1 - best.sse / sse0, 0, 1);
  const curvature = clip((1 - best.m) / 0.8, 0, 1);
  return { score: clip(improvement * curvature, 0, 1), fit: improvement };
}

// --- Monte-Carlo current-state simulation (dv, dlogP SDE) ----------------
//
// BUGFIX (2026-09-14): the drift force used to decay with a fixed 8-hour
// time constant (`Math.exp(-h / 8.0)`) regardless of how long the
// simulation horizon actually is. For a 24h-horizon run that means the
// force is already down to ~22% of its initial value by hour 12 and ~5%
// by hour 24 -- so almost the entire directional move happens in the
// first ~12-16h, and the 12h/24h targets collapse toward each other
// (pure diffusion, no more drift) instead of genuinely separating with
// the horizon. That's the "цена на 4/12/24ч сливается" behaviour seen on
// screen. Fix: scale the decay time constant to the simulation's own
// horizon (steps*dt) instead of a hardcoded 8h, so the far end of the
// forecast still carries a meaningful fraction of the original signal.
function simulateCurrentState(price, rv1h, force, disagreement, criticality, opts = {}) {
  const { steps = 48, dt = 0.5, paths = 1500, seed = 7 } = opts;
  const origin = price, sigma = Math.max(rv1h, 1e-6);
  const rng = mulberry32(seed);
  const gauss = gaussianFactory(rng);
  const n = Math.max(500, paths);
  const logp = new Float64Array(n).fill(Math.log(origin));
  const vel = new Float64Array(n);
  const out = [];
  const forceNoise = 0.18 + 0.32 * clip(disagreement, 0, 1) + 0.20 * clip(criticality, 0, 1);
  const priceNoise = 1.0 + 0.25 * clip(criticality, 0, 1);
  const gamma = 0.75;
  const totalHours = steps * dt;
  const decayTau = totalHours * 0.9; // ~33% of force retained at the horizon's edge (was ~5% with the old fixed 8h constant)
  for (let i = 1; i <= steps; i++) {
    const h = i * dt;
    const f = force * Math.exp(-h / decayTau);
    for (let j = 0; j < n; j++) {
      const zf = gauss(), zp = gauss();
      const acc = sigma * f - gamma * vel[j] + (sigma * forceNoise * zf) / Math.sqrt(Math.max(dt, 1e-9));
      vel[j] += acc * dt;
      logp[j] += vel[j] * dt + sigma * priceNoise * Math.sqrt(dt) * zp;
    }
    const prices = Array.from(logp, v => Math.exp(v)).sort((a, b) => a - b);
    const q = p => prices[Math.min(prices.length - 1, Math.floor(p * prices.length))];
    const q20 = q(0.20), q50 = q(0.50), q80 = q(0.80);
    let up = 0; for (const p of prices) if (p > origin) up++;
    out.push({
      minutes: Math.round(h * 60), center: q50, low: q20, high: q80,
      pUp: up / n, pDown: 1 - up / n, expectedReturnPct: (q50 / origin - 1) * 100,
    });
  }
  return out;
}

// --- feature helpers (oi / returns / realized vol) -----------------------
function recentReturn(closes, n) {
  if (!closes || closes.length < n + 1) return 0;
  const a = closes[closes.length - 1 - n], b = closes[closes.length - 1];
  return (a > 0 && b > 0) ? Math.log(b / a) : 0;
}
function rvStd(closes) {
  if (!closes || closes.length < 8) return 0.001;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const tail = rets.slice(-64);
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const variance = tail.reduce((a, b) => a + (b - mean) ** 2, 0) / (tail.length - 1 || 1);
  return Math.max(Math.sqrt(variance), 1e-6);
}
function realizedVol1h(closes15m) {
  const rets = [];
  for (let i = 1; i < closes15m.length; i++) rets.push(Math.log(closes15m[i] / closes15m[i - 1]));
  const tail = rets.slice(-96);
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const variance = tail.reduce((a, b) => a + (b - mean) ** 2, 0) / (tail.length - 1 || 1);
  return Math.max(Math.sqrt(variance) * 2.0, 0.0007); // 15m std -> 1h std (x sqrt(4))
}
function oiChange(hist, oi, n) {
  if (hist.length < n) return 0;
  const old = hist[hist.length - n]?.oi || 0;
  return (oi > 0 && old > 0) ? (oi / old - 1) : 0;
}

// --- structural anchor (swing high/low + ATR) -----------------------------
function atr14(candles) {
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], prevClose = i > 0 ? candles[i - 1].c : c.c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose)));
  }
  const last14 = trs.slice(-14);
  return last14.reduce((a, b) => a + b, 0) / (last14.length || 1);
}
function swingAnchor(candles1h, px, direction) {
  const x = candles1h.slice(-160);
  const atr = atr14(x) || px * 0.01;
  const localMin = i => { const w = x.slice(Math.max(0, i - 2), Math.min(x.length, i + 3)); return w.length === 5 ? Math.min(...w.map(c => c.l)) : NaN; };
  const localMax = i => { const w = x.slice(Math.max(0, i - 2), Math.min(x.length, i + 3)); return w.length === 5 ? Math.max(...w.map(c => c.h)) : NaN; };
  if (direction === 'LONG') {
    for (let i = x.length - 1; i >= 0; i--) if (x[i].l === localMin(i) && x[i].l < px) return x[i].l;
    return px - 1.5 * atr;
  }
  for (let i = x.length - 1; i >= 0; i--) if (x[i].h === localMax(i) && x[i].h > px) return x[i].h;
  return px + 1.5 * atr;
}
function persistedAnchor(direction, newAnchor, px) {
  let st = Store.get('apt_anchor', {});
  if (st.direction !== direction) st = { direction, anchor: newAnchor };
  else if (direction === 'LONG' && newAnchor > st.anchor && newAnchor < px) st.anchor = newAnchor;
  else if (direction === 'SHORT' && newAnchor < st.anchor && newAnchor > px) st.anchor = newAnchor;
  Store.set('apt_anchor', st);
  return st.anchor;
}

// --- orchestration: fetch + build the tunnel forecast ---------------------
async function buildTunnel() {
  const SYM = 'ETHUSDT', SYM_BTC = 'BTCUSDT', SYM_ETHBTC = 'ETHBTC';
  const [d15, d1h, btc15, ethbtc15] = await Promise.all([
    klinesPerp(SYM, '15m', 300),
    klinesPerp(SYM, '1h', 200),
    klinesSpot(SYM_BTC, '15m', 64),
    klinesSpot(SYM_ETHBTC, '15m', 64),
  ]);
  const cycle = String(d15[d15.length - 1].t);
  const livePrice = await livePricePerp(SYM);

  // Only the "slow" inputs (order flow snapshot, OI/funding/basis, LPPLS on
  // closed candles) are cached per 15m cycle, and the hist[] ledger is
  // appended exactly once per cycle (on cache miss below). The simulation
  // itself is NEVER cached: it always runs fresh off the current live
  // price, so the chart's "Сейчас" point and the "ETH LIVE" number on
  // screen can't ever show two different prices — which is what made the
  // tunnel look "stuck" earlier when price moved a lot mid-candle.
  let factors = Store.get('apt_factors_' + cycle, null);
  if (!factors) {
    const hist = Store.get('apt_states_' + SYM, []);
    const [spotPrice, funding, oi, perpTrades, perpDepth, spotTrades, spotDepth] = await Promise.all([
      livePriceSpot(SYM).catch(() => livePrice),
      fundingRate(SYM).catch(() => 0),
      openInterest(SYM).catch(() => 0),
      aggTradesPerp(SYM, 500).catch(() => []),
      depthPerp(SYM, 20).catch(() => ({ bids: [], asks: [] })),
      tradesSpot(SYM, 500).catch(() => []),
      depthSpot(SYM, 20).catch(() => ({ bids: [], asks: [] })),
    ]);

    const pt = tapeStats(perpTrades), st = tapeStats(spotTrades);
    const pb = bookGeometry(perpDepth), sb = bookGeometry(spotDepth);
    const spotPressure = impactPressure(st.signedPerMin, sb.depth);
    const perpPressure = impactPressure(pt.signedPerMin, pb.depth);
    const basis = spotPrice > 0 ? (livePrice / spotPrice - 1) : 0;
    const oi15 = oiChange(hist, oi, 1), oi1h = oiChange(hist, oi, 4), oi4h = oiChange(hist, oi, 16);
    const oiEnergy = 0.20 * normalise(oi15, 0.004) + 0.35 * normalise(oi1h, 0.008) + 0.45 * normalise(oi4h, 0.015);
    const crowd = 0.55 * normalise(funding, 0.0005) + 0.45 * normalise(basis, 0.0015);
    const positioning = clip(crowd * (0.55 + 0.45 * Math.abs(oiEnergy)));
    const liquidity = clip(0.55 * sb.imbalance + 0.45 * pb.imbalance);
    const closesBtc = btc15.map(c => c.c), closesEthbtc = ethbtc15.map(c => c.c);
    const btc1h = recentReturn(closesBtc, 4), eb1h = recentReturn(closesEthbtc, 4);
    const btcZ = normalise(btc1h, Math.max(rvStd(closesBtc) * 2, 1e-6));
    const ebZ = normalise(eb1h, Math.max(rvStd(closesEthbtc) * 2, 1e-6));
    const driver = clip(0.60 * btcZ + 0.40 * ebZ);
    const { force: rawForce, disagreement } = combineFive([spotPressure, perpPressure, positioning, liquidity, driver]);
    const force = latentForce(hist, rawForce);
    const rv1h = realizedVol1h(d15.map(c => c.c));
    const closes15 = d15.map(c => c.c);
    const lppl = lpplCriticality(closes15.slice(-160));
    const criticality = lppl.score;
    const qualityScore = [st.totalSize > 0, sb.depth > 0, pt.totalSize > 0, pb.depth > 0, oi > 0, spotPrice > 0, btc15.length > 0, ethbtc15.length > 0]
      .filter(Boolean).length / 8;

    factors = {
      force, disagreement, criticality, rv1h, qualityScore,
      forces: { spot_pressure: spotPressure, perp_pressure: perpPressure, positioning, liquidity, market_driver: driver },
    };
    Store.set('apt_factors_' + cycle, factors);

    hist.push({ physics_force_raw: rawForce, oi, cycle });
    Store.set('apt_states_' + SYM, hist.slice(-300));
  }

  const seed = hashSeed(cycle + '-' + Math.round(livePrice * 100));
  const sim = simulateCurrentState(livePrice, factors.rv1h, factors.force, factors.disagreement, factors.criticality, { steps: 48, dt: 0.5, paths: 1500, seed });
  const points = [{ minutes: 0, center: livePrice, low: livePrice, high: livePrice, pUp: 0.5, pDown: 0.5, expectedReturnPct: 0 }, ...sim];
  const pAt = h => points[h * 2];
  const p4 = pAt(4);
  const direction = p4.center >= livePrice ? 'LONG' : 'SHORT';
  const anchor = persistedAnchor(direction, swingAnchor(d1h, livePrice, direction), livePrice);
  const confidence = clip(25 + 65 * factors.qualityScore - 10 * factors.criticality, 20, 95);
  const supportingForces = Object.values(factors.forces).filter(v => (v > 0 && direction === 'LONG') || (v < 0 && direction === 'SHORT')).length;
  const opposingForces = Object.values(factors.forces).filter(v => (v < 0 && direction === 'LONG') || (v > 0 && direction === 'SHORT')).length;

  return {
    direction, confidence, originPrice: livePrice, livePrice, invalidation: anchor,
    targets: { '4h': p4.center, '12h': pAt(12).center, '24h': pAt(24).center },
    returnsPct: { '4h': p4.expectedReturnPct, '12h': pAt(12).expectedReturnPct, '24h': pAt(24).expectedReturnPct },
    directionProbability: { '4h': pAt(4), '12h': pAt(12), '24h': pAt(24) },
    forces: factors.forces, supportingForces, opposingForces, tunnel: points, cycle,
    historyClosed15m: d15.slice(-96),
  };
}

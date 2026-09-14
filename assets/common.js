// Shared utilities for the "APT tunnel" and "MEXC-style estimate" pages.
// No build step, no server: everything here runs directly in the browser
// on GitHub Pages, fetching public REST endpoints straight from the client
// (same pattern as the existing ETH Radar PWA — Binance public data has
// CORS enabled; OKX's REST API does not, which is why this port uses
// Binance instead of the original Python project's OKX feed).

const clip = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const normalise = (x, scale) => Math.tanh(x / Math.max(Math.abs(scale), 1e-12));

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// --- Binance data helpers ---------------------------------------------
const BINANCE_SPOT = 'https://api.binance.com';
const BINANCE_FUT  = 'https://fapi.binance.com';

function mapKline(r) {
  return { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closeTime: r[6] };
}
async function klinesSpot(symbol, interval, limit) {
  const rows = await getJSON(`${BINANCE_SPOT}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return rows.map(mapKline).filter(k => k.closeTime <= Date.now());
}
async function klinesPerp(symbol, interval, limit) {
  const rows = await getJSON(`${BINANCE_FUT}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return rows.map(mapKline).filter(k => k.closeTime <= Date.now());
}
async function depthSpot(symbol, limit = 20) { return getJSON(`${BINANCE_SPOT}/api/v3/depth?symbol=${symbol}&limit=${limit}`); }
async function depthPerp(symbol, limit = 20) { return getJSON(`${BINANCE_FUT}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`); }
async function tradesSpot(symbol, limit = 500) {
  const rows = await getJSON(`${BINANCE_SPOT}/api/v3/trades?symbol=${symbol}&limit=${limit}`);
  return rows.map(t => ({ price: +t.price, qty: +t.qty, time: t.time, isBuyerMaker: t.isBuyerMaker }));
}
async function aggTradesPerp(symbol, limit = 500) {
  const rows = await getJSON(`${BINANCE_FUT}/fapi/v1/aggTrades?symbol=${symbol}&limit=${limit}`);
  return rows.map(t => ({ price: +t.p, qty: +t.q, time: t.T, isBuyerMaker: t.m }));
}
async function fundingRate(symbol) {
  const d = await getJSON(`${BINANCE_FUT}/fapi/v1/premiumIndex?symbol=${symbol}`);
  return +(d.lastFundingRate ?? 0);
}
async function openInterest(symbol) {
  const d = await getJSON(`${BINANCE_FUT}/fapi/v1/openInterest?symbol=${symbol}`);
  return +(d.openInterest ?? 0);
}
async function livePricePerp(symbol) {
  const d = await getJSON(`${BINANCE_FUT}/fapi/v1/ticker/price?symbol=${symbol}`);
  return +d.price;
}
async function livePriceSpot(symbol) {
  const d = await getJSON(`${BINANCE_SPOT}/api/v3/ticker/price?symbol=${symbol}`);
  return +d.price;
}

// --- order-flow feature helpers -----------------------------------------
function bookGeometry(depth, levels = 20) {
  try {
    const bids = (depth.bids || []).slice(0, levels);
    const asks = (depth.asks || []).slice(0, levels);
    const b = bids.reduce((s, x) => s + parseFloat(x[1]), 0);
    const a = asks.reduce((s, x) => s + parseFloat(x[1]), 0);
    const bp = bids.length ? parseFloat(bids[0][0]) : 0;
    const ap = asks.length ? parseFloat(asks[0][0]) : 0;
    const mid = (bp > 0 && ap > 0) ? (bp + ap) / 2 : 0;
    const spreadBps = mid > 0 ? ((ap - bp) / mid) * 10000 : 0;
    const tot = b + a;
    return { bidDepth: b, askDepth: a, depth: tot, imbalance: tot <= 0 ? 0 : clip((b - a) / tot), spreadBps };
  } catch {
    return { bidDepth: 0, askDepth: 0, depth: 0, imbalance: 0, spreadBps: 0 };
  }
}
function tapeStats(trades) {
  let buy = 0, sell = 0; const ts = [];
  for (const t of (trades || [])) {
    if (t.isBuyerMaker) sell += t.qty; else buy += t.qty; // taker side = aggressor
    ts.push(t.time / 1000);
  }
  const tot = buy + sell, signed = buy - sell;
  const span = ts.length >= 2 ? Math.max(...ts) - Math.min(...ts) : 0;
  const effective = Math.max(span, 10);
  return { imbalance: tot <= 0 ? 0 : clip(signed / tot), signedPerMin: (signed * 60) / effective, totalSize: tot, span };
}
function impactPressure(signedPerMin, depth) {
  return Math.tanh(signedPerMin / (0.35 * Math.max(depth, 1e-9)));
}

// --- deterministic RNG (mulberry32) + Box-Muller gaussian ---------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function gaussianFactory(rng) {
  let spare = null;
  return function () {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, s;
    do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

// --- tiny localStorage-backed store (replaces the Python sqlite store.py) -
const Store = {
  get(key, def = null) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
};

// --- shared canvas chart renderer ----------------------------------------
function drawTunnelChart(canvas, hist, pts, originPrice, invalidation, direction, futureHours = 24) {
  const ctx = canvas.getContext('2d');
  const r = canvas.getBoundingClientRect();
  const D = devicePixelRatio || 1;
  canvas.width = r.width * D; canvas.height = r.height * D; ctx.setTransform(D, 0, 0, D, 0, 0);
  const W = r.width, H = r.height, padL = 54, padR = 22, padT = 24, padB = 42;
  if (!pts.length) return;
  const histHours = hist.length * 0.25;
  const totalHours = histHours + futureHours;
  const Xh = h => padL + (W - padL - padR) * (h + histHours) / totalHours;
  const allY = [];
  hist.forEach(x => allY.push(x.h, x.l));
  pts.forEach(x => allY.push(x.low, x.high));
  allY.push(originPrice);
  let ymin = Math.min(...allY), ymax = Math.max(...allY);
  const baseSpan = Math.max(ymax - ymin, 1);
  ymin -= baseSpan * 0.08; ymax += baseSpan * 0.08;
  const span = ymax - ymin;
  const Y = v => H - padB - (H - padT - padB) * (v - ymin) / span;
  ctx.clearRect(0, 0, W, H); ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const val = ymax - (span * i) / 4, y = Y(val);
    ctx.strokeStyle = '#263244'; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = '#8190a4'; ctx.fillText(val.toFixed(0), 4, y + 4);
  }
  if (hist.length) {
    const cw = Math.max(1.2, (W - padL - padR) * (0.25 / totalHours) * 0.56);
    hist.forEach((q, i) => {
      const h = -histHours + i * 0.25, x = Xh(h);
      const yo = Y(q.o), yc = Y(q.c), yh = Y(q.h), yl = Y(q.l), up = q.c >= q.o;
      ctx.strokeStyle = up ? '#7f93aa' : '#6f7f93';
      ctx.beginPath(); ctx.moveTo(x, yh); ctx.lineTo(x, yl); ctx.stroke();
      ctx.fillStyle = up ? '#9bacbe' : '#68798d';
      ctx.fillRect(x - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
    });
  }
  const nowY = Y(originPrice);
  ctx.setLineDash([5, 5]); ctx.strokeStyle = '#8494a9'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, nowY); ctx.lineTo(W - padR, nowY); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#9aa9bb'; ctx.fillText('Сейчас ' + originPrice.toFixed(2), Math.max(padL + 4, Xh(0) + 6), nowY - 7);
  ctx.fillStyle = 'rgba(65,126,255,.16)'; ctx.beginPath();
  pts.forEach((p, i) => { const x = Xh(p.minutes / 60), y = Y(p.high); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; ctx.lineTo(Xh(p.minutes / 60), Y(p.low)); }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(65,126,255,.65)'; ctx.lineWidth = 1.2;
  for (const key of ['high', 'low']) {
    ctx.beginPath();
    pts.forEach((p, i) => { const x = Xh(p.minutes / 60), y = Y(p[key]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.strokeStyle = direction === 'LONG' ? '#39d98a' : '#ff5f6d'; ctx.lineWidth = 4; ctx.beginPath();
  pts.forEach((p, i) => { const x = Xh(p.minutes / 60), y = Y(p.center); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = '#f4f7fb'; ctx.beginPath(); ctx.arc(Xh(0), nowY, 4.5, 0, Math.PI * 2); ctx.fill();
  if (Number.isFinite(invalidation)) {
    if (invalidation >= ymin && invalidation <= ymax) {
      const yi = Y(invalidation);
      ctx.setLineDash([7, 5]); ctx.strokeStyle = '#f5b642'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(padL, yi); ctx.lineTo(W - padR, yi); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#f5b642'; ctx.fillText('INVALIDATION ' + invalidation.toFixed(2), W - padR - 145, yi - 7);
    } else {
      ctx.fillStyle = '#f5b642'; ctx.fillText('Invalidation ' + invalidation.toFixed(2) + ' вне масштаба', padL, H - 7);
    }
  }
  ctx.fillStyle = '#93a4b8';
  [-24, -12, 0, 8, 16, 24].forEach(h => {
    if (h < -histHours) return;
    const label = h === 0 ? 'СЕЙЧАС' : (h < 0 ? h + 'h' : '+' + h + 'h');
    ctx.fillText(label, Xh(h) - 18, H - 18);
  });
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath();
  ctx.moveTo(Xh(0), padT); ctx.lineTo(Xh(0), H - padB); ctx.stroke();
}

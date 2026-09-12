// This is NOT MEXC's real model — MEXC has never published its Smart Chart
// architecture, weights or training data, and there is no leaked spec to
// port. This is our own reconstruction of a "similar-shaped" model, built
// only from what MEXC states publicly about the feature (press releases,
// MEXC Learn): technical indicators, funding/positioning-style crowd data,
// upcoming macro/exchange events, and — per their AI Strategy release —
// a social/sentiment signal. We substitute a public sentiment proxy
// (alternative.me Fear & Greed Index) since MEXC's own social-listening
// pipeline isn't accessible from a static page. The calendar itself is
// real (Forex Factory's public weekly feed, High/Medium impact only) —
// not MEXC's own event feed, but genuine upcoming macro events.
//
// The propagation step (simulateCurrentState) is intentionally the SAME
// function used by the tunnel engine — the interesting methodological
// difference between "your APT" and "a MEXC-like estimator" is in how the
// five/six input factors are built, not in how a distribution is grown out
// of them. Reusing it here makes that comparison honest instead of hiding
// it behind two different-looking codebases.

function ema(closes, period) {
  const k = 2 / (period + 1);
  let v = closes[0];
  const out = [v];
  for (let i = 1; i < closes.length; i++) { v = closes[i] * k + v * (1 - k); out.push(v); }
  return out;
}
function trendScore(closes) {
  if (closes.length < 55) return 0;
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const last = closes.length - 1;
  const gap = (e20[last] - e50[last]) / closes[last];
  const slope = (e20[last] - e20[last - 5]) / closes[last];
  return clip(Math.tanh(gap / 0.01) * 0.6 + Math.tanh(slope / 0.006) * 0.4);
}
function rsi14(closes) {
  if (closes.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const avgGain = gains / 14, avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function macdHistScore(closes) {
  if (closes.length < 35) return 0;
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => e12[i] - e26[i]);
  const signal = ema(macdLine, 9);
  const last = closes.length - 1;
  const hist = macdLine[last] - signal[last];
  return clip(Math.tanh(hist / (closes[last] * 0.004)));
}

async function fearGreedScore() {
  try {
    const d = await getJSON('https://api.alternative.me/fng/?limit=1');
    const v = +d.data[0].value; // 0..100
    return { raw: v, score: clip((v - 50) / 50) };
  } catch { return { raw: 50, score: 0 }; }
}

// Real macro calendar: Forex Factory's public weekly JSON feed (no key,
// CORS-enabled, widely used by client-side calendar widgets and MT4/5 EAs).
// Rate-limited by the source to ~2 requests/5min per URL, so the raw feed
// is cached in localStorage for 30 minutes regardless of how often the
// page polls for a price update.
const FF_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
async function fetchCalendarRaw() {
  const cache = Store.get('ff_calendar_cache', null);
  const now = Date.now();
  if (cache && (now - cache.fetchedAt) < 30 * 60000) return cache.data;
  try {
    const raw = await getJSON(FF_CALENDAR_URL);
    Store.set('ff_calendar_cache', { fetchedAt: now, data: raw });
    return raw;
  } catch {
    return cache ? cache.data : [];
  }
}
async function upcomingEvents(nowMs, hoursAhead = 48, maxItems = 4) {
  const raw = await fetchCalendarRaw();
  return raw
    .filter(e => e.impact === 'High' || e.impact === 'Medium')
    .map(e => ({
      t: new Date(e.date).getTime(),
      title: `${e.country || ''} ${e.title || ''}`.trim(),
      note: [e.forecast ? `прогноз ${e.forecast}` : null, e.previous ? `пред. ${e.previous}` : null].filter(Boolean).join(' · '),
      impact: e.impact,
    }))
    .filter(e => Number.isFinite(e.t) && e.t >= nowMs && e.t <= nowMs + hoursAhead * 3600000)
    .sort((a, b) => a.t - b.t)
    .slice(0, maxItems);
}
function calendarRiskScore(events, nowMs) {
  let risk = 0;
  for (const e of events) {
    const hoursTo = (e.t - nowMs) / 3600000;
    if (hoursTo >= 0) risk = Math.max(risk, Math.exp(-hoursTo / 2));
  }
  return clip(risk, 0, 1);
}

async function buildMexcStyleEstimate() {
  const SYM = 'ETHUSDT';
  const [d15, d1h, d4h] = await Promise.all([
    klinesPerp(SYM, '15m', 300),
    klinesPerp(SYM, '1h', 200),
    klinesPerp(SYM, '4h', 120),
  ]);
  const cycle = String(d15[d15.length - 1].t);
  const livePrice = await livePricePerp(SYM);
  const cached = Store.get('mexcstyle_forecast_' + cycle, null);
  if (cached) {
    cached.livePrice = livePrice;
    cached.historyClosed15m = d15.slice(-96);
    return cached;
  }

  const funding = await fundingRate(SYM).catch(() => 0);
  const fg = await fearGreedScore();
  const closes15 = d15.map(c => c.c), closes1h = d1h.map(c => c.c), closes4h = d4h.map(c => c.c);

  const trendCombined = clip(0.5 * trendScore(closes4h) + 0.3 * trendScore(closes1h) + 0.2 * trendScore(closes15));
  const rsiScore = clip((rsi14(closes1h) - 50) / 30);
  const macdScore = macdHistScore(closes1h);
  const fundingScore = normalise(funding, 0.0005);
  const sentimentScore = fg.score;

  const ensemble = [trendCombined, rsiScore, macdScore, fundingScore, sentimentScore];
  const weights = [0.35, 0.15, 0.15, 0.15, 0.20];
  const weighted = ensemble.reduce((s, v, i) => s + v * weights[i], 0);
  const force = Math.tanh(weighted / 0.5);
  const mean = weighted;
  const disagreement = Math.sqrt(ensemble.reduce((s, v) => s + (v - mean) ** 2, 0) / ensemble.length);

  const events = await upcomingEvents(Date.now());
  const criticality = calendarRiskScore(events, Date.now());
  const rv1h = realizedVol1h(closes15);
  const seed = hashSeed('mexcstyle-' + cycle);
  const sim = simulateCurrentState(livePrice, rv1h, force, disagreement, criticality, { steps: 48, dt: 0.5, paths: 1500, seed });
  const points = [{ minutes: 0, center: livePrice, low: livePrice, high: livePrice, pUp: 0.5, pDown: 0.5, expectedReturnPct: 0 }, ...sim];
  const pAt = h => points[h * 2];
  const p4 = pAt(4);
  const direction = p4.center >= livePrice ? 'LONG' : 'SHORT';
  const pUp24 = pAt(24).pUp;

  const forecast = {
    direction, originPrice: livePrice,
    longPct: Math.round(pUp24 * 100), shortPct: 100 - Math.round(pUp24 * 100),
    pUp7dLike: pUp24, // our sim horizon tops out at 24h; labelled honestly below
    targets: { '4h': p4.center, '12h': pAt(12).center, '24h': pAt(24).center },
    returnsPct: { '4h': p4.expectedReturnPct, '12h': pAt(12).expectedReturnPct, '24h': pAt(24).expectedReturnPct },
    directionProbability: { '4h': pAt(4), '12h': pAt(12), '24h': pAt(24) },
    factors: { trend: trendCombined, rsi: rsiScore, macd: macdScore, funding: fundingScore, sentiment: sentimentScore, fgiRaw: fg.raw },
    events, tunnel: points, cycle,
  };
  Store.set('mexcstyle_forecast_' + cycle, forecast);
  forecast.livePrice = livePrice;
  forecast.historyClosed15m = d15.slice(-96);
  return forecast;
}

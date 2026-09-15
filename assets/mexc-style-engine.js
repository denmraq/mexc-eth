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
//
// BUGFIX 1 (2026-09-14): Forex Factory rate-limits this endpoint to ~2
// requests/5min per client; when exceeded it returns an HTML "Request
// Denied" page (frequently with a 200 status), which getJSON's r.json()
// call turns into a thrown JSON-parse error. The old code caught that
// and silently fell back to `[]` — indistinguishable from "genuinely no
// events this week" in the UI.
//   - Cache TTL raised from 30min to 6h.
//   - fetchCalendarRaw() now returns a status ('ok' | 'stale_cache' |
//     'failed') alongside the data, propagated through upcomingEvents()
//     and the estimate object, so the UI can say "calendar unavailable"
//     instead of implying a confirmed empty calendar.
//
// BUGFIX 2 (2026-09-14, later same day): fetch attempts were only gated by
// the 15-minute price-candle cycle (one attempt per new candle, via the
// `factors` cache in buildMexcStyleEstimate). During active testing/
// reloading across many candle cycles in a short span, that's still enough
// distinct attempts to blow through FF's 2-requests-per-5-minutes limit
// repeatedly -- and each failure only stayed "remembered" for the rest of
// that one 15-minute cycle, so the next cycle retried almost immediately,
// often still inside FF's cooldown window, recreating the same failure
// indefinitely. Now the last attempt time is tracked independently of the
// price cycle, with its own 20-minute cooldown, so a known-failed fetch
// actually backs off instead of retrying every ~15 minutes forever.
const FF_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_CACHE_TTL_MS = 6 * 3600000;
const FF_RETRY_COOLDOWN_MS = 20 * 60000;

async function fetchCalendarRaw() {
  const cache = Store.get('ff_calendar_cache', null);
  const now = Date.now();
  if (cache && Array.isArray(cache.data) && (now - cache.fetchedAt) < FF_CACHE_TTL_MS) {
    return { data: cache.data, status: 'ok' };
  }
  const lastAttempt = Store.get('ff_calendar_last_attempt', 0);
  if (now - lastAttempt < FF_RETRY_COOLDOWN_MS) {
    return (cache && Array.isArray(cache.data))
      ? { data: cache.data, status: 'stale_cache' }
      : { data: [], status: 'failed' };
  }
  Store.set('ff_calendar_last_attempt', now);
  try {
    const raw = await getJSON(FF_CALENDAR_URL);
    if (!Array.isArray(raw)) throw new Error('unexpected calendar payload (likely rate-limited HTML response)');
    Store.set('ff_calendar_cache', { fetchedAt: now, data: raw });
    return { data: raw, status: 'ok' };
  } catch {
    if (cache && Array.isArray(cache.data)) return { data: cache.data, status: 'stale_cache' };
    return { data: [], status: 'failed' };
  }
}
async function upcomingEvents(nowMs, hoursAhead = 72, maxItems = 6) {
  const { data: raw, status } = await fetchCalendarRaw();
  const events = raw
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
  return { events, calendarStatus: status };
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

  // Only the "slow" inputs (TA on closed candles, funding, sentiment,
  // calendar) are cached per 15m cycle — partly for stability, partly to
  // respect the Forex Factory rate limit. The simulation itself is NOT
  // cached: it always runs fresh off the current live price, so the chart
  // and the "ETH LIVE" number on screen can never show two different
  // prices at once, even if the price moved a lot mid-candle.
  let factors = Store.get('mexcstyle_factors_' + cycle, null);
  if (!factors) {
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
    const disagreement = Math.sqrt(ensemble.reduce((s, v) => s + (v - weighted) ** 2, 0) / ensemble.length);

    const { events, calendarStatus } = await upcomingEvents(Date.now());
    const criticality = calendarRiskScore(events, Date.now());
    const rv1h = realizedVol1h(closes15);

    factors = {
      force, disagreement, criticality, rv1h, events, calendarStatus,
      display: { trend: trendCombined, rsi: rsiScore, macd: macdScore, funding: fundingScore, sentiment: sentimentScore, fgiRaw: fg.raw },
    };
    Store.set('mexcstyle_factors_' + cycle, factors);
  }

  const seed = hashSeed('mexcstyle-' + cycle + '-' + Math.round(livePrice * 100));
  const sim = simulateCurrentState(livePrice, factors.rv1h, factors.force, factors.disagreement, factors.criticality, { steps: 48, dt: 0.5, paths: 1500, seed });
  const points = [{ minutes: 0, center: livePrice, low: livePrice, high: livePrice, pUp: 0.5, pDown: 0.5, expectedReturnPct: 0 }, ...sim];
  const pAt = h => points[h * 2];
  const p4 = pAt(4);
  const direction = p4.center >= livePrice ? 'LONG' : 'SHORT';
  const pUp24 = pAt(24).pUp;

  return {
    direction, originPrice: livePrice, livePrice,
    longPct: Math.round(pUp24 * 100), shortPct: 100 - Math.round(pUp24 * 100),
    pUp7dLike: pUp24, // our sim horizon tops out at 24h; labelled honestly below
    targets: { '4h': p4.center, '12h': pAt(12).center, '24h': pAt(24).center },
    returnsPct: { '4h': p4.expectedReturnPct, '12h': pAt(12).expectedReturnPct, '24h': pAt(24).expectedReturnPct },
    directionProbability: { '4h': pAt(4), '12h': pAt(12), '24h': pAt(24) },
    factors: factors.display,
    events: factors.events, calendarStatus: factors.calendarStatus, tunnel: points, cycle,
    historyClosed15m: d15.slice(-96),
  };
}

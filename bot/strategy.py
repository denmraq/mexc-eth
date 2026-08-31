import numpy as np


def ema(x, p):
    x = np.asarray(x, float)
    out = np.empty_like(x)
    a = 2 / (p + 1)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def rsi(x, p=14):
    x = np.asarray(x, float)
    d = np.diff(x, prepend=x[0])
    up = np.maximum(d, 0)
    dn = np.maximum(-d, 0)
    au = ema(up, p)
    ad = ema(dn, p)
    return 100 - (100 / (1 + au / (ad + 1e-12)))


def atr(h, l, c, p=14):
    h = np.asarray(h, float)
    l = np.asarray(l, float)
    c = np.asarray(c, float)
    pc = np.roll(c, 1)
    pc[0] = c[0]
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    return ema(tr, p)


def feats(k):
    c = np.asarray(k["close"], float)
    h = np.asarray(k["high"], float)
    l = np.asarray(k["low"], float)
    v = np.asarray(k["vol"], float)
    e20 = ema(c, 20)
    e50 = ema(c, 50)
    rr = rsi(c)
    aa = atr(h, l, c)
    px = c[-1]
    vm = float(np.median(v[-30:])) or 1
    return {
        "price": float(px),
        "ema20": float(e20[-1]),
        "ema50": float(e50[-1]),
        "rsi": float(rr[-1]),
        "atr": float(aa[-1]),
        "atr_pct": float(aa[-1] / px * 100),
        "vol_ratio": float(v[-1] / vm),
        "ret3": float(px / c[-4] - 1),
        "breakout_up": bool(px > np.max(h[-21:-1])),
        "breakout_down": bool(px < np.min(l[-21:-1])),
    }


def obi(depth, levels=10):
    bids = (depth.get("bids") or [])[:levels]
    asks = (depth.get("asks") or [])[:levels]

    def q(r):
        return float(r[2] if len(r) >= 3 else (r[1] if len(r) >= 2 else 0))

    b = sum(q(x) for x in bids)
    a = sum(q(x) for x in asks)
    return (b - a) / (b + a) if b + a else 0


def tape(deals, n=100):
    if isinstance(deals, dict):
        deals = deals.get("data") or deals.get("deals") or []
    buy = sell = 0.0
    for d in (deals or [])[:n]:
        x = float(d.get("price", 0) or 0) * float(d.get("vol", 0) or 0)
        s = d.get("side")
        if s in (1, "1", "buy", "BUY"):
            buy += x
        elif s in (2, "2", "sell", "SELL"):
            sell += x
    return (buy - sell) / (buy + sell) if buy + sell else 0


def _component(name, long_points=0.0, short_points=0.0, detail=""):
    return {
        "name": name,
        "long": round(float(long_points), 3),
        "short": round(float(short_points), 3),
        "detail": detail,
    }


def decide(k5, k15, depth, deals, min_atr=0.12, max_atr=1.8):
    a = feats(k5)
    b = feats(k15)
    ob = obi(depth)
    tp = tape(deals)
    components = []
    reasons = []

    # IMPORTANT: scoring weights are unchanged from V1.0.
    if a["ema20"] > a["ema50"]:
        components.append(_component("ema_5m", 18, 0, "EMA20 > EMA50"))
    else:
        components.append(_component("ema_5m", 0, 18, "EMA20 <= EMA50"))

    if b["ema20"] > b["ema50"]:
        components.append(_component("ema_15m", 22, 0, "EMA20 > EMA50"))
    else:
        components.append(_component("ema_15m", 0, 22, "EMA20 <= EMA50"))

    rsi_l = 12 if 52 <= a["rsi"] <= 70 else 0
    rsi_s = 12 if 30 <= a["rsi"] <= 48 else 0
    components.append(_component("rsi_5m", rsi_l, rsi_s, f"RSI={a['rsi']:.2f}"))

    components.append(
        _component("momentum_5m", 8 if a["ret3"] > 0 else 0, 0 if a["ret3"] > 0 else 8, f"ret3={a['ret3']:.5f}")
    )
    components.append(
        _component("momentum_15m", 8 if b["ret3"] > 0 else 0, 0 if b["ret3"] > 0 else 8, f"ret3={b['ret3']:.5f}")
    )

    bo_l = 12 if a["breakout_up"] and a["vol_ratio"] >= 1.15 else 0
    bo_s = 12 if a["breakout_down"] and a["vol_ratio"] >= 1.15 else 0
    if bo_l:
        reasons.append("breakout up + volume")
    if bo_s:
        reasons.append("breakout down + volume")
    components.append(
        _component(
            "breakout_volume",
            bo_l,
            bo_s,
            f"up={a['breakout_up']} down={a['breakout_down']} vol_ratio={a['vol_ratio']:.3f}",
        )
    )

    components.append(_component("orderbook", max(0, ob) * 10, max(0, -ob) * 10, f"obi={ob:.4f}"))
    components.append(_component("tape", max(0, tp) * 10, max(0, -tp) * 10, f"tape={tp:.4f}"))

    long_raw = sum(x["long"] for x in components)
    short_raw = sum(x["short"] for x in components)

    agree = (a["ema20"] > a["ema50"]) == (b["ema20"] > b["ema50"])
    agreement_multiplier = 1.0 if agree else 0.78
    if not agree:
        reasons.append("5m/15m disagreement")

    L = long_raw * agreement_multiplier
    S = short_raw * agreement_multiplier
    direction = "LONG" if L >= S else "SHORT"
    score_pre_cap = max(L, S)
    score = min(100, score_pre_cap)
    weak_edge = abs(L - S) < 12
    if weak_edge:
        score = min(score, 64)
        reasons.append("weak edge")

    tradable = min_atr <= a["atr_pct"] <= max_atr
    if not tradable:
        reasons.append(f"ATR filter {a['atr_pct']:.3f}% not in [{min_atr:.3f}, {max_atr:.3f}]")

    breakdown = {
        "components": components,
        "long_raw": round(long_raw, 3),
        "short_raw": round(short_raw, 3),
        "agreement": bool(agree),
        "agreement_multiplier": agreement_multiplier,
        "long_after_agreement": round(L, 3),
        "short_after_agreement": round(S, 3),
        "edge": round(abs(L - S), 3),
        "weak_edge_cap_applied": bool(weak_edge),
        "score_pre_cap": round(score_pre_cap, 3),
        "final_score": round(score, 1),
        "atr_pct": round(a["atr_pct"], 4),
        "atr_range": [float(min_atr), float(max_atr)],
    }

    return {
        "direction": direction,
        "score": round(score, 1),
        "long_score": round(L, 1),
        "short_score": round(S, 1),
        "tradable": tradable,
        "obi": round(ob, 3),
        "tape": round(tp, 3),
        "f5": a,
        "f15": b,
        "reasons": reasons,
        "breakdown": breakdown,
    }

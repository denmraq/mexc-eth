import os
import time
import uuid
from datetime import datetime, timezone, timedelta
from .mexc import MexcFutures
from .strategy import decide
from .storage import Store


def _env_float(primary, default, *aliases):
    for key in (primary,) + aliases:
        value = os.getenv(key)
        if value not in (None, ""):
            try:
                return float(value)
            except ValueError:
                pass
    return float(default)


def _env_int(primary, default, *aliases):
    return int(_env_float(primary, default, *aliases))


class Trader:
    def __init__(self):
        self.symbol = os.getenv("SYMBOL", "ETH_USDT")
        self.mode = os.getenv("TRADING_MODE", "PAPER").upper()
        self.live_enabled = (
            os.getenv("ENABLE_LIVE_TRADING") == "YES_I_UNDERSTAND"
            and os.getenv("LIVE_CONFIRMATION") == "I_ACCEPT_REAL_MONEY_RISK"
        )
        self.leverage = _env_int("LEVERAGE", 2)
        self.equity = _env_float("ACCOUNT_EQUITY_USDT", 1000)
        self.risk_pct = _env_float("RISK_PER_TRADE_PCT", 0.35, "RISK_PER_TRADE")
        # Backward compatibility: if old RISK_PER_TRADE was entered as 0.0035, interpret as 0.35%.
        if os.getenv("RISK_PER_TRADE_PCT") in (None, "") and 0 < self.risk_pct < 0.05:
            self.risk_pct *= 100
        self.max_daily_loss = _env_float("MAX_DAILY_LOSS_PCT", 1.5, "DAILY_MAX_LOSS")
        if os.getenv("MAX_DAILY_LOSS_PCT") in (None, "") and 0 < self.max_daily_loss < 0.1:
            self.max_daily_loss *= 100
        self.max_trades = _env_int("MAX_TRADES_PER_DAY", 8)
        self.max_losses = _env_int("MAX_CONSECUTIVE_LOSSES", 3)
        self.cooldown = _env_int("COOLDOWN_MINUTES", 20)
        self.max_notional = _env_float("MAX_POSITION_NOTIONAL_USDT", 500, "MAX_NOTIONAL_USDT")
        self.entry_score = _env_float("ENTRY_SCORE", 72, "MIN_SCORE")
        self.min_atr = _env_float("MIN_ATR_PCT", 0.12)
        self.max_atr = _env_float("MAX_ATR_PCT", 1.8)
        self.api = MexcFutures(
            os.getenv("MEXC_API_KEY", ""),
            os.getenv("MEXC_SECRET_KEY", os.getenv("MEXC_API_SECRET", "")),
        )
        self.db = Store()
        self.last_signal = None
        self.last_price = None
        self.last_tick = None
        self.last_error = None
        self.last_close = None
        self.contract = None

    def status(self):
        return {
            "mode": self.mode,
            "live_enabled": self.live_enabled,
            "symbol": self.symbol,
            "last_price": self.last_price,
            "last_signal": self.last_signal,
            "position": self.db.open_position(),
            "daily": self.db.daily(),
            "consecutive_losses": self.db.streak(),
            "last_tick": self.last_tick,
            "last_error": self.last_error,
            "entry_score": self.entry_score,
            "recent_decisions": self.db.recent_decisions(20),
        }

    def _risk_gate(self):
        s = self.db.daily()
        if s["trades"] >= self.max_trades:
            return False, "DAILY_TRADE_LIMIT"
        if s["pnl"] <= -(self.equity * self.max_daily_loss / 100):
            return False, "DAILY_LOSS_LIMIT"
        if self.db.streak() >= self.max_losses:
            return False, "LOSS_STREAK_LIMIT"
        if self.last_close and datetime.now(timezone.utc) < self.last_close + timedelta(minutes=self.cooldown):
            return False, "COOLDOWN"
        return True, "RISK_OK"

    def _cs(self):
        if self.contract is None:
            self.contract = self.api.contract_detail(self.symbol)
        try:
            return float(self.contract.get("contractSize") or 1)
        except Exception:
            return 1.0

    def _size(self, price, stop):
        risk = self.equity * self.risk_pct / 100
        dist = max(abs(price - stop), price * 0.001)
        base = risk / dist
        notional = min(base * price, self.max_notional)
        base = notional / price
        cs = max(self._cs(), 1e-12)
        contracts = max(1, int(base / cs))
        return contracts, contracts * cs * price

    def _enter(self, sig, price):
        atr = sig["f5"]["atr"]
        sd = max(atr * 1.35, price * 0.0025)
        if sig["direction"] == "LONG":
            stop = price - sd
            take = price + sd * 1.8
            side = 1
        else:
            stop = price + sd
            take = price - sd * 1.8
            side = 3
        contracts, notional = self._size(price, stop)
        oid = "ethbot-" + uuid.uuid4().hex[:18]
        if self.mode == "LIVE":
            if not self.live_enabled:
                raise RuntimeError("LIVE blocked by safety lock")
            self.api.submit_market(self.symbol, contracts, side, self.leverage, stop, take, oid)
        reason = (
            f"score={sig['score']} long={sig['long_score']} short={sig['short_score']} "
            f"obi={sig['obi']} tape={sig['tape']}"
        )
        tid = self.db.open_trade(
            opened_at=datetime.now(timezone.utc).isoformat(),
            mode=self.mode,
            direction=sig["direction"],
            entry=price,
            stop=stop,
            take=take,
            contracts=contracts,
            notional=notional,
            reason=reason,
            external_oid=oid,
        )
        self.db.event(
            f"OPEN {self.mode} {sig['direction']} #{tid} entry={price:.2f} SL={stop:.2f} TP={take:.2f} "
            f"score={sig['score']} long={sig['long_score']} short={sig['short_score']} obi={sig['obi']} tape={sig['tape']}"
        )
        return tid

    def _monitor(self, price):
        p = self.db.open_position()
        if not p:
            return
        d = p["direction"]
        stop = float(p["stop"])
        take = float(p["take"])
        why = None
        if d == "LONG" and price <= stop:
            why = "STOP"
        elif d == "LONG" and price >= take:
            why = "TAKE_PROFIT"
        elif d == "SHORT" and price >= stop:
            why = "STOP"
        elif d == "SHORT" and price <= take:
            why = "TAKE_PROFIT"
        if not why:
            return
        if self.mode == "LIVE":
            pos = self.api.positions(self.symbol) or []
            active = [x for x in pos if float(x.get("holdVol", x.get("vol", 0)) or 0) > 0]
            if active:
                x = active[0]
                vol = float(x.get("holdVol", x.get("vol", p["contracts"])) or p["contracts"])
                self.api.close_market(self.symbol, vol, d, self.leverage, x.get("positionId"))
        entry = float(p["entry"])
        raw = (price - entry) if d == "LONG" else (entry - price)
        pnl = raw * self._cs() * float(p["contracts"])
        if self.mode == "PAPER":
            pnl -= float(p["notional"]) * 0.001
        self.db.close_trade(p["id"], price, pnl, raw / entry * 100, why)
        self.last_close = datetime.now(timezone.utc)
        self.db.event(f"CLOSE {d} #{p['id']} {why} exit={price:.2f} pnl={pnl:.2f}")

    def _gate_for_signal(self, sig):
        if self.db.open_position():
            return False, "OPEN_POSITION"
        risk_ok, risk_reason = self._risk_gate()
        if not risk_ok:
            return False, risk_reason
        if not sig["tradable"]:
            return False, "ATR_FILTER"
        if sig["score"] < self.entry_score:
            return False, f"SCORE_BELOW_{self.entry_score:g}"
        return True, "ENTRY_READY"

    def tick(self):
        t = self.api.ticker(self.symbol)
        price = float(t.get("lastPrice") or t.get("last") or t.get("fairPrice"))
        self.last_price = price
        self._monitor(price)
        sig = decide(
            self.api.kline(self.symbol, "Min5"),
            self.api.kline(self.symbol, "Min15"),
            self.api.depth(self.symbol, 20),
            self.api.deals(self.symbol),
            self.min_atr,
            self.max_atr,
        )
        self.last_signal = sig
        self.last_tick = datetime.now(timezone.utc).isoformat()

        eligible, gate_reason = self._gate_for_signal(sig)
        if eligible:
            tid = self._enter(sig, price)
            did = self.db.decision(price=price, sig=sig, eligible=True, gate_reason="ENTERED", trade_id=tid)
            self.db.attach_decision_to_trade(tid, did)
        else:
            self.db.decision(price=price, sig=sig, eligible=False, gate_reason=gate_reason)

    def run_forever(self):
        self.db.event(f"BOT START V1.1 mode={self.mode} symbol={self.symbol}")
        while True:
            try:
                self.tick()
                self.last_error = None
            except Exception as e:
                self.last_error = f"{type(e).__name__}: {e}"
                self.db.event(self.last_error, "ERROR")
            time.sleep(15)

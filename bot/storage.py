import json
import sqlite3
import threading
from datetime import datetime, timezone, date
from pathlib import Path


class Store:
    def __init__(self, path="data/trader.db"):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        with sqlite3.connect(path) as c:
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS trades(
                    id INTEGER PRIMARY KEY,opened_at TEXT,closed_at TEXT,mode TEXT,direction TEXT,
                    entry REAL,exit REAL,stop REAL,take REAL,contracts REAL,notional REAL,pnl REAL,
                    pnl_pct REAL,status TEXT,reason TEXT,external_oid TEXT
                );
                CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,ts TEXT,level TEXT,message TEXT);
                CREATE TABLE IF NOT EXISTS decisions(
                    id INTEGER PRIMARY KEY,
                    ts TEXT,
                    price REAL,
                    direction TEXT,
                    score REAL,
                    long_score REAL,
                    short_score REAL,
                    tradable INTEGER,
                    eligible INTEGER,
                    gate_reason TEXT,
                    trade_id INTEGER,
                    obi REAL,
                    tape REAL,
                    reasons_json TEXT,
                    breakdown_json TEXT,
                    features_json TEXT
                );
                """
            )
            # Safe migration for existing V1.0 databases.
            cols = {r[1] for r in c.execute("PRAGMA table_info(trades)").fetchall()}
            if "decision_id" not in cols:
                c.execute("ALTER TABLE trades ADD COLUMN decision_id INTEGER")

    def event(self, m, l="INFO"):
        with self.lock, sqlite3.connect(self.path) as c:
            c.execute(
                "INSERT INTO events(ts,level,message) VALUES(?,?,?)",
                (datetime.now(timezone.utc).isoformat(), l, m),
            )

    def decision(self, *, price, sig, eligible, gate_reason, trade_id=None):
        features = {"f5": sig.get("f5"), "f15": sig.get("f15")}
        with self.lock, sqlite3.connect(self.path) as c:
            cur = c.execute(
                """INSERT INTO decisions(
                    ts,price,direction,score,long_score,short_score,tradable,eligible,gate_reason,
                    trade_id,obi,tape,reasons_json,breakdown_json,features_json
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    datetime.now(timezone.utc).isoformat(),
                    float(price),
                    sig.get("direction"),
                    float(sig.get("score") or 0),
                    float(sig.get("long_score") or 0),
                    float(sig.get("short_score") or 0),
                    1 if sig.get("tradable") else 0,
                    1 if eligible else 0,
                    gate_reason,
                    trade_id,
                    float(sig.get("obi") or 0),
                    float(sig.get("tape") or 0),
                    json.dumps(sig.get("reasons") or [], ensure_ascii=False),
                    json.dumps(sig.get("breakdown") or {}, ensure_ascii=False),
                    json.dumps(features, ensure_ascii=False),
                ),
            )
            return cur.lastrowid

    def attach_decision_to_trade(self, trade_id, decision_id):
        with self.lock, sqlite3.connect(self.path) as c:
            c.execute("UPDATE trades SET decision_id=? WHERE id=?", (decision_id, trade_id))

    def open_trade(self, **x):
        with self.lock, sqlite3.connect(self.path) as c:
            cur = c.execute(
                """INSERT INTO trades(
                    opened_at,mode,direction,entry,stop,take,contracts,notional,status,reason,external_oid
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    x["opened_at"], x["mode"], x["direction"], x["entry"], x["stop"], x["take"],
                    x["contracts"], x["notional"], "OPEN", x.get("reason", ""), x.get("external_oid", "")
                ),
            )
            return cur.lastrowid

    def close_trade(self, i, px, pnl, pct, why):
        with self.lock, sqlite3.connect(self.path) as c:
            c.execute(
                """UPDATE trades SET closed_at=?,exit=?,pnl=?,pnl_pct=?,status='CLOSED',reason=reason||?
                   WHERE id=?""",
                (datetime.now(timezone.utc).isoformat(), px, pnl, pct, " | " + why, i),
            )

    def _dict(self, row, c):
        cols = [x[1] for x in c.execute("PRAGMA table_info(trades)").fetchall()]
        return dict(zip(cols, row))

    def open_position(self):
        with sqlite3.connect(self.path) as c:
            r = c.execute("SELECT * FROM trades WHERE status='OPEN' ORDER BY id DESC LIMIT 1").fetchone()
            return self._dict(r, c) if r else None

    def recent(self, n=30):
        with sqlite3.connect(self.path) as c:
            return [self._dict(r, c) for r in c.execute("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (n,)).fetchall()]

    def recent_decisions(self, n=30):
        with sqlite3.connect(self.path) as c:
            rows = c.execute(
                """SELECT id,ts,price,direction,score,long_score,short_score,tradable,eligible,gate_reason,
                          trade_id,obi,tape,reasons_json,breakdown_json,features_json
                   FROM decisions ORDER BY id DESC LIMIT ?""",
                (n,),
            ).fetchall()
        keys = [
            "id","ts","price","direction","score","long_score","short_score","tradable","eligible",
            "gate_reason","trade_id","obi","tape","reasons_json","breakdown_json","features_json"
        ]
        out = []
        for row in rows:
            d = dict(zip(keys, row))
            for k in ("reasons_json", "breakdown_json", "features_json"):
                try:
                    d[k[:-5] if k.endswith("_json") else k] = json.loads(d.pop(k) or ("[]" if k == "reasons_json" else "{}"))
                except Exception:
                    pass
            d["tradable"] = bool(d["tradable"])
            d["eligible"] = bool(d["eligible"])
            out.append(d)
        return out

    def events(self, n=25):
        with sqlite3.connect(self.path) as c:
            return [
                {"ts": r[0], "level": r[1], "message": r[2]}
                for r in c.execute("SELECT ts,level,message FROM events ORDER BY id DESC LIMIT ?", (n,))
            ]

    def daily(self):
        with sqlite3.connect(self.path) as c:
            r = c.execute(
                "SELECT pnl FROM trades WHERE status='CLOSED' AND substr(closed_at,1,10)=?",
                (date.today().isoformat(),),
            ).fetchall()
        v = [float(x[0] or 0) for x in r]
        return {"trades": len(v), "pnl": sum(v), "wins": sum(x > 0 for x in v), "losses": sum(x < 0 for x in v)}

    def streak(self):
        with sqlite3.connect(self.path) as c:
            r = c.execute("SELECT pnl FROM trades WHERE status='CLOSED' ORDER BY id DESC LIMIT 20").fetchall()
        n = 0
        for (p,) in r:
            if float(p or 0) < 0:
                n += 1
            else:
                break
        return n

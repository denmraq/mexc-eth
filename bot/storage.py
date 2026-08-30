import sqlite3,threading
from datetime import datetime,timezone,date
from pathlib import Path
class Store:
    def __init__(self,path="data/trader.db"):
        Path(path).parent.mkdir(parents=True,exist_ok=True); self.path=path; self.lock=threading.Lock()
        with sqlite3.connect(path) as c:c.executescript("""
        CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY,opened_at TEXT,closed_at TEXT,mode TEXT,direction TEXT,entry REAL,exit REAL,stop REAL,take REAL,contracts REAL,notional REAL,pnl REAL,pnl_pct REAL,status TEXT,reason TEXT,external_oid TEXT);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,ts TEXT,level TEXT,message TEXT);""")
    def event(self,m,l="INFO"):
        with self.lock,sqlite3.connect(self.path) as c:c.execute("INSERT INTO events(ts,level,message) VALUES(?,?,?)",(datetime.now(timezone.utc).isoformat(),l,m))
    def open_trade(self,**x):
        with self.lock,sqlite3.connect(self.path) as c:
            cur=c.execute("INSERT INTO trades(opened_at,mode,direction,entry,stop,take,contracts,notional,status,reason,external_oid) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (x["opened_at"],x["mode"],x["direction"],x["entry"],x["stop"],x["take"],x["contracts"],x["notional"],"OPEN",x.get("reason",""),x.get("external_oid",""))); return cur.lastrowid
    def close_trade(self,i,px,pnl,pct,why):
        with self.lock,sqlite3.connect(self.path) as c:c.execute("UPDATE trades SET closed_at=?,exit=?,pnl=?,pnl_pct=?,status='CLOSED',reason=reason||? WHERE id=?",(datetime.now(timezone.utc).isoformat(),px,pnl,pct," | "+why,i))
    def _dict(self,row,c):
        cols=[x[1] for x in c.execute("PRAGMA table_info(trades)").fetchall()]; return dict(zip(cols,row))
    def open_position(self):
        with sqlite3.connect(self.path) as c:
            r=c.execute("SELECT * FROM trades WHERE status='OPEN' ORDER BY id DESC LIMIT 1").fetchone(); return self._dict(r,c) if r else None
    def recent(self,n=30):
        with sqlite3.connect(self.path) as c:return [self._dict(r,c) for r in c.execute("SELECT * FROM trades ORDER BY id DESC LIMIT ?",(n,)).fetchall()]
    def events(self,n=25):
        with sqlite3.connect(self.path) as c:return [{"ts":r[0],"level":r[1],"message":r[2]} for r in c.execute("SELECT ts,level,message FROM events ORDER BY id DESC LIMIT ?",(n,))]
    def daily(self):
        with sqlite3.connect(self.path) as c:r=c.execute("SELECT pnl FROM trades WHERE status='CLOSED' AND substr(closed_at,1,10)=?",(date.today().isoformat(),)).fetchall()
        v=[float(x[0] or 0) for x in r]; return {"trades":len(v),"pnl":sum(v),"wins":sum(x>0 for x in v),"losses":sum(x<0 for x in v)}
    def streak(self):
        with sqlite3.connect(self.path) as c:r=c.execute("SELECT pnl FROM trades WHERE status='CLOSED' ORDER BY id DESC LIMIT 20").fetchall()
        n=0
        for (p,) in r:
            if float(p or 0)<0:n+=1
            else:break
        return n

import os
import threading
import secrets
from fastapi import FastAPI, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from dotenv import load_dotenv
import uvicorn

load_dotenv()
from bot.engine import Trader

app = FastAPI(title="MEXC ETH Trader V1.1")
security = HTTPBasic()
trader = Trader()


def auth(c: HTTPBasicCredentials = Depends(security)):
    user = os.getenv("DASHBOARD_USER", os.getenv("DASHBOARD_USERNAME", "admin"))
    ok = secrets.compare_digest(c.username, user) and secrets.compare_digest(
        c.password, os.getenv("DASHBOARD_PASSWORD", "CHANGE_ME_NOW")
    )
    if not ok:
        raise HTTPException(401, headers={"WWW-Authenticate": "Basic"})
    return True


@app.on_event("startup")
def startup():
    threading.Thread(target=trader.run_forever, daemon=True).start()


@app.get("/health")
def health():
    return {"status": "ok", "mode": trader.mode, "version": "1.1"}


@app.get("/api/status")
def status(_=Depends(auth)):
    s = trader.status()
    s["recent_trades"] = trader.db.recent()
    s["events"] = trader.db.events()
    return s


@app.get("/", response_class=HTMLResponse)
def home(_=Depends(auth)):
    return """<!doctype html><html lang=ru><meta name=viewport content='width=device-width,initial-scale=1'><style>
body{font-family:-apple-system;background:#0b1019;color:#eef;padding:18px}.w{max-width:720px;margin:auto}.c{background:#151d2a;border:1px solid #2a3547;border-radius:15px;padding:15px;margin:12px 0}.big{font-size:30px;font-weight:900}.L{color:#49d17d}.S{color:#ff6464}.sm{color:#9ba9bc;font-size:13px;line-height:1.5}.tag{display:inline-block;padding:3px 7px;border:1px solid #34445a;border-radius:8px;margin:2px;font-size:11px}.ok{color:#49d17d}.no{color:#ffb35c}details{margin-top:8px}pre{white-space:pre-wrap;font-size:11px;color:#c4cedc}
</style><body><div class=w><h2>MEXC ETH TRADER V1.1</h2><div id=x>Загрузка…</div></div><script>
function esc(x){return String(x??'—').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}
function breakdown(q){let b=q.breakdown||{},cs=b.components||[];return cs.map(c=>`<span class=tag>${esc(c.name)} L:${c.long} S:${c.short}</span>`).join('')}
async function g(){let s=await fetch('/api/status').then(r=>r.json()),q=s.last_signal||{},p=s.position,d=q.direction||'WAIT',ds=s.recent_decisions||[],last=ds[0]||{};document.getElementById('x').innerHTML=`
<div class=c><div class=sm>Режим</div><div class=big>${s.mode}</div></div>
<div class=c><div class=big>ETH ${s.last_price??'—'}</div><div class='big ${d=='LONG'?'L':'S'}'>${d} · ${q.score??'—'}</div><div class=sm>LONG ${q.long_score??'—'} · SHORT ${q.short_score??'—'} · вход ≥ ${s.entry_score??'—'}<br>Order book ${q.obi??'—'} · Tape ${q.tape??'—'} · ATR ${q.f5?.atr_pct?.toFixed?.(3)??'—'}%</div><details><summary>Расшифровка текущего score</summary><div>${breakdown(q)}</div><pre>${esc(JSON.stringify(q.breakdown||{},null,2))}</pre></details></div>
<div class=c><b>Решение сейчас</b><div class='sm ${last.eligible?'ok':'no'}'>${last.gate_reason??'—'}</div><div class=sm>${(q.reasons||[]).join(' · ')||'без дополнительных причин'}</div></div>
<div class=c><b>Позиция</b><div class=sm>${p?`${p.direction} · entry ${p.entry} · SL ${p.stop} · TP ${p.take}`:'Нет позиции'}</div></div>
<div class=c><b>Сегодня</b><div class=sm>Сделок ${s.daily.trades} · PnL ${Number(s.daily.pnl).toFixed(2)} USDT · wins ${s.daily.wins} · losses ${s.daily.losses}</div></div>
<div class=c><b>Последние решения</b><div class=sm>${ds.slice(0,10).map(e=>`${e.ts.slice(11,19)} · ${e.direction} ${e.score} · ${e.gate_reason} · OBI ${e.obi} · tape ${e.tape}`).join('<br>')}</div></div>
<div class=c><b>События</b><div class=sm>${(s.events||[]).map(e=>e.ts.slice(11,19)+' '+e.level+': '+e.message).join('<br>')}</div></div>
<div class=c><div class=sm>Last tick ${s.last_tick??'—'}<br>Error ${s.last_error??'—'}</div></div>`}
g();setInterval(g,5000)</script>"""


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))

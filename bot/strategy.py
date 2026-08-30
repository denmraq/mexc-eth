import numpy as np

def ema(x,p):
    x=np.asarray(x,float); out=np.empty_like(x); a=2/(p+1); out[0]=x[0]
    for i in range(1,len(x)): out[i]=a*x[i]+(1-a)*out[i-1]
    return out

def rsi(x,p=14):
    x=np.asarray(x,float); d=np.diff(x,prepend=x[0]); up=np.maximum(d,0); dn=np.maximum(-d,0)
    au=ema(up,p); ad=ema(dn,p); return 100-(100/(1+au/(ad+1e-12)))

def atr(h,l,c,p=14):
    h=np.asarray(h,float); l=np.asarray(l,float); c=np.asarray(c,float); pc=np.roll(c,1); pc[0]=c[0]
    tr=np.maximum(h-l,np.maximum(np.abs(h-pc),np.abs(l-pc))); return ema(tr,p)

def feats(k):
    c=np.asarray(k["close"],float); h=np.asarray(k["high"],float); l=np.asarray(k["low"],float); v=np.asarray(k["vol"],float)
    e20=ema(c,20); e50=ema(c,50); rr=rsi(c); aa=atr(h,l,c)
    px=c[-1]; vm=float(np.median(v[-30:])) or 1
    return {"price":float(px),"ema20":float(e20[-1]),"ema50":float(e50[-1]),"rsi":float(rr[-1]),
            "atr":float(aa[-1]),"atr_pct":float(aa[-1]/px*100),"vol_ratio":float(v[-1]/vm),
            "ret3":float(px/c[-4]-1),"breakout_up":bool(px>np.max(h[-21:-1])),
            "breakout_down":bool(px<np.min(l[-21:-1]))}

def obi(depth,levels=10):
    bids=(depth.get("bids") or [])[:levels]; asks=(depth.get("asks") or [])[:levels]
    q=lambda r: float(r[2] if len(r)>=3 else (r[1] if len(r)>=2 else 0))
    b=sum(q(x) for x in bids); a=sum(q(x) for x in asks)
    return (b-a)/(b+a) if b+a else 0

def tape(deals,n=100):
    if isinstance(deals,dict): deals=deals.get("data") or deals.get("deals") or []
    buy=sell=0.0
    for d in (deals or [])[:n]:
        x=float(d.get("price",0) or 0)*float(d.get("vol",0) or 0); s=d.get("side")
        if s in (1,"1","buy","BUY"): buy+=x
        elif s in (2,"2","sell","SELL"): sell+=x
    return (buy-sell)/(buy+sell) if buy+sell else 0

def decide(k5,k15,depth,deals,min_atr=0.12,max_atr=1.8):
    a=feats(k5); b=feats(k15); ob=obi(depth); tp=tape(deals); L=S=0.0; reasons=[]
    if a["ema20"]>a["ema50"]:L+=18
    else:S+=18
    if b["ema20"]>b["ema50"]:L+=22
    else:S+=22
    if 52<=a["rsi"]<=70:L+=12
    if 30<=a["rsi"]<=48:S+=12
    if a["ret3"]>0:L+=8
    else:S+=8
    if b["ret3"]>0:L+=8
    else:S+=8
    if a["breakout_up"] and a["vol_ratio"]>=1.15:L+=12; reasons.append("breakout up + volume")
    if a["breakout_down"] and a["vol_ratio"]>=1.15:S+=12; reasons.append("breakout down + volume")
    L+=max(0,ob)*10+max(0,tp)*10; S+=max(0,-ob)*10+max(0,-tp)*10
    agree=(a["ema20"]>a["ema50"])==(b["ema20"]>b["ema50"])
    if not agree:L*=.78;S*=.78;reasons.append("5m/15m disagreement")
    tradable=min_atr<=a["atr_pct"]<=max_atr
    d="LONG" if L>=S else "SHORT"; score=min(100,max(L,S))
    if abs(L-S)<12:score=min(score,64);reasons.append("weak edge")
    return {"direction":d,"score":round(score,1),"long_score":round(L,1),"short_score":round(S,1),
            "tradable":tradable,"obi":round(ob,3),"tape":round(tp,3),"f5":a,"f15":b,"reasons":reasons}

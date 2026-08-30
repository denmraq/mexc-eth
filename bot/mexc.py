import hashlib,hmac,json,time
from urllib.parse import urlencode,quote
import requests

class MexcError(RuntimeError): pass

class MexcFutures:
    def __init__(self,api_key="",secret_key="",base="https://api.mexc.com",timeout=10):
        self.api_key=api_key or ""; self.secret_key=secret_key or ""
        self.base=base.rstrip("/"); self.timeout=timeout
        self.s=requests.Session()
        self.s.headers.update({"User-Agent":"MEXC-ETH-TRADER-V1/1.0"})

    def _check(self,r):
        r.raise_for_status(); p=r.json()
        if p.get("success") is False or p.get("code",0) not in (0,None):
            raise MexcError(f"MEXC error: {p}")
        return p.get("data",p)

    def public_get(self,path,params=None):
        return self._check(self.s.get(self.base+path,params=params or {},timeout=self.timeout))

    @staticmethod
    def _qs(params):
        items=[(k,v) for k,v in (params or {}).items() if v is not None]
        items.sort(key=lambda x:x[0])
        return urlencode(items,doseq=True,quote_via=quote)

    def _headers(self,method,params=None,body=None):
        if not self.api_key or not self.secret_key: raise MexcError("MEXC API keys are not configured")
        ts=str(int(time.time()*1000))
        payload=self._qs(params) if method.upper() in ("GET","DELETE") else json.dumps(body or {},separators=(",",":"),ensure_ascii=False)
        sig=hmac.new(self.secret_key.encode(),(self.api_key+ts+payload).encode(),hashlib.sha256).hexdigest()
        return {"ApiKey":self.api_key,"Request-Time":ts,"Signature":sig,"Content-Type":"application/json","Recv-Window":"10000"},payload

    def private_get(self,path,params=None):
        params=params or {}; h,_=self._headers("GET",params=params)
        return self._check(self.s.get(self.base+path,params=params,headers=h,timeout=self.timeout))

    def private_post(self,path,body=None):
        body=body or {}; h,payload=self._headers("POST",body=body)
        return self._check(self.s.post(self.base+path,data=payload.encode(),headers=h,timeout=self.timeout))

    def contract_detail(self,symbol):
        data=self.public_get("/api/v1/contract/detail",{"symbol":symbol})
        if isinstance(data,list):
            for x in data:
                if x.get("symbol")==symbol:return x
        return data

    def ticker(self,symbol):
        data=self.public_get("/api/v1/contract/ticker")
        if isinstance(data,list):
            for x in data:
                if x.get("symbol")==symbol:return x
        if isinstance(data,dict) and data.get("symbol")==symbol:return data
        raise MexcError("Ticker not found")

    def kline(self,symbol,interval,bars=220):
        sec={"Min1":60,"Min5":300,"Min15":900,"Min30":1800,"Min60":3600,"Hour4":14400}[interval]
        end=int(time.time()); start=end-sec*(bars+5)
        return self.public_get(f"/api/v1/contract/kline/{symbol}",{"interval":interval,"start":start,"end":end})

    def depth(self,symbol,limit=20):
        return self.public_get(f"/api/v1/contract/depth/{symbol}",{"limit":limit})

    def deals(self,symbol):
        return self.public_get(f"/api/v1/contract/deals/{symbol}")

    def positions(self,symbol=None):
        data=self.private_get("/api/v1/private/position/open_positions")
        if symbol and isinstance(data,list): return [p for p in data if p.get("symbol")==symbol]
        return data

    def submit_market(self,symbol,vol,side,leverage,stop_loss=None,take_profit=None,external_oid=None):
        b={"symbol":symbol,"price":0,"vol":float(vol),"leverage":int(leverage),"side":int(side),"type":5,"openType":1}
        if stop_loss is not None:b["stopLossPrice"]=float(stop_loss)
        if take_profit is not None:b["takeProfitPrice"]=float(take_profit)
        if external_oid:b["externalOid"]=external_oid
        return self.private_post("/api/v1/private/order/submit",b)

    def close_market(self,symbol,vol,direction,leverage,position_id=None):
        b={"symbol":symbol,"price":0,"vol":float(vol),"leverage":int(leverage),"side":4 if direction=="LONG" else 2,"type":5,"openType":1}
        if position_id is not None:b["positionId"]=position_id
        return self.private_post("/api/v1/private/order/submit",b)

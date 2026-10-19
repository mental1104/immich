from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection
import os, threading, time
RATE=int(os.environ.get('HLS_BENCHMARK_RATE_BPS', '3000000'))
BURST=int(os.environ.get('HLS_BENCHMARK_BURST_BYTES', '64000'))
BACKEND_HOST=os.environ.get('HLS_BENCHMARK_BACKEND_HOST', '172.17.0.1')
BACKEND_PORT=int(os.environ.get('HLS_BENCHMARK_BACKEND_PORT', '2284'))
LISTEN_HOST=os.environ.get('HLS_BENCHMARK_PROXY_HOST', '127.0.0.1')
LISTEN_PORT=int(os.environ.get('HLS_BENCHMARK_PROXY_PORT', '2285'))
lock=threading.Lock(); tokens=float(BURST); updated=time.monotonic(); total=0; started=time.monotonic()
def take(n):
 global tokens,updated,total
 sent=0
 while sent<n:
  with lock:
   now=time.monotonic(); tokens=min(float(BURST),tokens+(now-updated)*RATE); updated=now
   amount=min(n-sent,int(tokens))
   if amount:
    tokens-=amount;total+=amount
  if amount:
   sent+=amount
  else:
   time.sleep(max(0.001,min(0.02,(1-tokens)/RATE)))
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def do_GET(self): self.forward()
 def do_DELETE(self): self.forward()
 def do_HEAD(self): self.forward(head=True)
 def forward(self,head=False):
  conn=HTTPConnection(BACKEND_HOST,BACKEND_PORT,timeout=60)
  headers={k:v for k,v in self.headers.items() if k.lower() not in ('host','connection','keep-alive','proxy-connection')}
  try:
   conn.request(self.command,self.path,headers=headers)
   res=conn.getresponse();self.send_response(res.status,res.reason)
   for k,v in res.getheaders():
    if k.lower() not in ('connection','keep-alive','transfer-encoding','proxy-connection'):
     self.send_header(k,v)
   self.send_header('Connection','close');self.end_headers()
   start=time.monotonic();size=0
   if not head and res.status not in (204,304):
    while True:
     chunk=res.read(16384)
     if not chunk:break
     take(len(chunk));self.wfile.write(chunk);size+=len(chunk)
   elapsed=time.monotonic()-start
   if size:
    with lock: cumulative=total;uptime=time.monotonic()-started
    print(f'path={self.path.split("?")[0].split("/")[-1]} bytes={size} elapsed={elapsed:.3f}s rate={size/max(elapsed,0.001):.0f}B/s aggregate={cumulative}B uptime={uptime:.1f}s',flush=True)
  except Exception as e:
   try:self.send_error(502,str(e))
   except:pass
  finally:conn.close();self.close_connection=True
 def log_message(self,*args):pass
ThreadingHTTPServer((LISTEN_HOST,LISTEN_PORT),Handler).serve_forever()

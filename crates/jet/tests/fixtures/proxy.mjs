import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';

const name = process.env.FIXTURE_NAME ?? 'Notebook';
const base = process.env.FIXTURE_BASE ?? '/notes/';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const path = url.pathname.slice(base.length);
  if (!url.pathname.startsWith(base)) { res.writeHead(404); return res.end(); }
  if (path === 'jet-app.json') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({version:1,name,ui:'./',embedding:'relative-paths'}));
  }
  if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
  if (path === 'headers' || path.startsWith('headers/')) { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({name,url:req.url,headers:req.headers})); }
  if (path === 'redirect') { res.writeHead(302, {location:url.searchParams.get('to') ?? 'headers?redirected=yes#part'}); return res.end(); }
  if (path === 'binary') {
    res.writeHead(206, {'content-type':'application/octet-stream','content-disposition':'attachment; filename=bytes.bin','set-cookie':['a=1','b=2'],'x-frame-options':'SAMEORIGIN','content-security-policy':"frame-ancestors 'self'",connection:'x-private','x-private':'secret'});
    res.write(Buffer.from([0,1,127])); setTimeout(() => res.end(Buffer.from([128,255])), 80); return;
  }
  if (path === 'upload') { res.writeHead(201, {'content-type':'application/octet-stream'}); req.pipe(res); return; }
  if (path === '') {
    res.setHeader('content-type','text/html');
    return res.end(`<!doctype html><title>${name}</title><h1>${name}</h1><label>Unsaved note <textarea aria-label="Unsaved note"></textarea></label><p id="socket">Connecting</p><script>const u=new URL('socket',location.href);u.protocol=location.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(u,'fixture');ws.onopen=()=>ws.send('browser echo');ws.onmessage=e=>document.querySelector('#socket').textContent=e.data;</script>`);
  }
  res.writeHead(404); res.end('No fixture route');
});
const sockets = new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
  if (req.url !== `${base}socket`) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndenied'); return; }
  sockets.handleUpgrade(req,socket,head,ws=>{
    ws.send(JSON.stringify({headers:req.headers}));
    ws.on('message',(data,binary)=>ws.send(data,{binary}));
  });
});
await new Promise(resolve=>server.listen(Number(process.env.FIXTURE_PORT ?? 0),'127.0.0.1',resolve));
const stalled = new Set();
const stall = net.createServer(socket => { stalled.add(socket); socket.on('close', () => stalled.delete(socket)); });
await new Promise(resolve => stall.listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({stall: `https://127.0.0.1:${stall.address().port}/`, url:`http://127.0.0.1:${server.address().port}${base}`}));
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{for(const ws of sockets.clients)ws.terminate();server.close();for(const socket of stalled)socket.destroy();stall.close();});

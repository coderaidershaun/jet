import assert from 'node:assert/strict';
import WebSocket from 'ws';
const [jet,id,upstream]=process.argv.slice(2);
function connect(path,origin) {
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(`${jet.replace('http:','ws:')}/apps/${id}/${path}`,'fixture',{origin,headers:{'x-forwarded-for':'forged','x-forwarded-host':'forged'}});
    const messages=[];socket.on('message',(value,binary)=>messages.push({value,binary}));
    socket.on('open',()=>resolve({socket,messages}));socket.on('error',reject);
  });
}
const {socket,messages}=await connect('socket',jet);
assert.equal(socket.protocol,'fixture');
const until=async condition=>{const end=Date.now()+3000;while(!condition()){assert.ok(Date.now()<end,'websocket response timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
await until(()=>messages.length===1);
const observed=JSON.parse(messages.shift().value).headers;
assert.equal(observed.origin,new URL(upstream).origin);
assert.equal(observed.host,new URL(upstream).host);
assert.equal(observed['x-forwarded-host'],new URL(jet).host);
assert.equal(observed['x-forwarded-proto'],'http');
assert.equal(observed['x-forwarded-prefix'],`/apps/${id}`);
assert.equal(observed['x-forwarded-for'],undefined);
socket.send('text echo');socket.send(Buffer.from([0,255,127,128]));
await until(()=>messages.length===2);
assert.equal(messages[0].value.toString(),'text echo');assert.equal(messages[0].binary,false);
assert.deepEqual(messages[1].value,Buffer.from([0,255,127,128]));assert.equal(messages[1].binary,true);
socket.close();
await assert.rejects(connect('socket','http://forged.invalid'),/403/);
await assert.rejects(connect('refused',jet),/403/);
console.log('WebSocket handshake, origin, subprotocol, binary/text echo and refusal passed');

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
let sessionKey='', workspace='';
const server=createServer((req,res)=>{
  const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  if(req.url==='/api/auth/token')return json({token:'fixture-token'});
  if(req.url==='/api/projects'&&req.method==='POST'){let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>{const body=JSON.parse(data);if(body.gitAction!=='initialize'){res.statusCode=409;json({code:'GIT_CONFIRMATION_REQUIRED'});return;}workspace=body.path;json({id:'fixture-workspace'});});return;}
  if(req.url==='/api/projects')return json([]);
  return json({events:[],history:{before:null}});
});
server.on('upgrade',(req,socket)=>{
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffer=Buffer.alloc(0);
  socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=2){
    const opcode=buffer[0]&15;let size=buffer[1]&127,offset=2;
    if(size===126){if(buffer.length<4)return;size=buffer.readUInt16BE(2);offset=4;}
    const masked=Boolean(buffer[1]&128),mask=buffer.subarray(offset,offset+4);if(masked)offset+=4;if(buffer.length<offset+size)return;
    const bytes=Buffer.from(buffer.subarray(offset,offset+size));buffer=buffer.subarray(offset+size);if(masked)for(let i=0;i<bytes.length;i++)bytes[i]^=mask[i%4];
    if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}if(opcode!==1)continue;
    const m=JSON.parse(bytes.toString());let result;
    if(m.type==='list_harnesses')result={type:'harness_list',harnesses:[{name:'codex'}]};
    if(m.type==='create_session'){sessionKey=m.sessionKey;appendFileSync(process.env.MINIONS_HOME+'/launches','1');writeFileSync(workspace+'/answer.mjs','console.log(42)');result={type:'session_created',sessionKey};}
    if(m.type==='list_sessions')result={type:'session_list',sessions:[{sessionKey,status:'idle'}]};
    if(m.type==='sync_session')result={type:'sync_response',sessionKey,status:'idle',usageTotals:{input:2,cacheRead:0,cacheCreation:0,output:1},turns:1,totalCost:0};
    if(!result)continue;
    const payload=Buffer.from(JSON.stringify(result));socket.write(Buffer.concat([payload.length<126?Buffer.from([0x81,payload.length]):Buffer.from([0x81,126,payload.length>>8,payload.length&255]),payload]));
  }});
});
server.listen(Number(process.env.PORT),'127.0.0.1');

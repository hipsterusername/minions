import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
/** Minimal RFC6455 fixture at the real network boundary; no app/runtime dependencies. */
export async function protocolServer(handler:(message:any)=>any, history:(url:string)=>unknown=()=>({events:[],history:{before:null}})) {
  const sockets=new Set<Socket>(); const commands:any[]=[];
  const server=createServer((req,res)=>{if(!req.url?.startsWith('/api/auth/token')&&req.headers.authorization!=='Bearer fixture-token'){res.writeHead(401);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url?.startsWith('/api/auth/token')?{token:'fixture-token'}:history(req.url!)));});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(req,socket)=>{
    if(new URL(req.url!,'http://localhost').searchParams.get('token')!=='fixture-token'){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=2){
        const opcode=buffer[0]&15;let size=buffer[1]&127;let offset=2;
        if(size===126){if(buffer.length<4)return;size=buffer.readUInt16BE(2);offset=4;}
        if(size===127)throw new Error('oversized fixture frame');
        const masked=Boolean(buffer[1]&128);const mask=buffer.subarray(offset,offset+4);if(masked)offset+=4;
        if(buffer.length<offset+size)return;
        const bytes=Buffer.from(buffer.subarray(offset,offset+size));buffer=buffer.subarray(offset+size);
        if(masked)for(let i=0;i<bytes.length;i++)bytes[i]^=mask[i%4];
        if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}
        if(opcode!==1)continue;
        const message=JSON.parse(bytes.toString());commands.push(message);const result=handler(message);if(result===undefined)continue;
        const payload=Buffer.from(JSON.stringify({...result,topic:{kind:'global'}}));const header=payload.length<126?Buffer.from([0x81,payload.length]):Buffer.from([0x81,126,payload.length>>8,payload.length&255]);socket.write(Buffer.concat([header,payload]));
      }
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address() as {port:number};
  return {endpoint:`ws://127.0.0.1:${address.port}`,commands,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

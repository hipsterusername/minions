import { randomUUID } from 'node:crypto';
/** Actual app commands have both correlated and uncorrelated replies. Each request owns a socket. */
export class MinionsTransport {
  constructor(readonly endpoint:string, readonly timeoutMs=10_000) {}
  private token:string|undefined;
  async connectionURL():Promise<string> {
    const url=new URL(this.endpoint);
    if(url.searchParams.has('token'))return url.href;
    if(!this.token){
      const auth=new URL('/api/auth/token',url);auth.protocol=url.protocol==='wss:'?'https:':'http:';
      const response=await fetch(auth,{signal:AbortSignal.timeout(this.timeoutMs)});
      if(!response.ok)throw new Error(`dedicated instance authentication HTTP ${response.status}`);
      const body=await response.json() as {token?:string};if(!body.token)throw new Error('missing dedicated instance auth token');this.token=body.token;
    }
    url.searchParams.set('token',this.token);return url.href;
  }
  async headers():Promise<Record<string,string>> {return {authorization:`Bearer ${new URL(await this.connectionURL()).searchParams.get('token')}`};}
  async send(command:Record<string,unknown>):Promise<void> {
    const endpoint=await this.connectionURL();
    return new Promise((resolve,reject)=>{const ws=new WebSocket(endpoint);const timer=setTimeout(()=>{ws.close();reject(new Error('Minions send timed out'));},this.timeoutMs);
      ws.addEventListener('open',()=>{ws.send(JSON.stringify(command));ws.close();clearTimeout(timer);resolve();});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Minions send failed'));});});
  }
  async request(command:Record<string,unknown>, expected?:string): Promise<any> {
    const requestId=typeof command.requestId==='string'?command.requestId:randomUUID();
    const endpoint=await this.connectionURL();
    return new Promise((resolve,reject)=>{
      const socket=new WebSocket(endpoint);
      const finish=(error:Error|null,value?:unknown)=>{clearTimeout(timer);socket.close();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(new Error(`Minions ${command.type} timed out`)),this.timeoutMs);
      socket.addEventListener('open',()=>socket.send(JSON.stringify({...command,requestId})));
      socket.addEventListener('message',event=>{
        try {
          const wire=JSON.parse(String(event.data)); const message=wire.payload ?? wire;
          if (message.type==='error' || (message.type==='session_error' && message.sessionKey===command.sessionKey)) return finish(new Error(message.error ?? message.message));
          const correlated=message.requestId===requestId;
          const uncorrelated=expected && message.type===expected && (!command.sessionKey || message.sessionKey===command.sessionKey) && (!command.workItemId || !message.workItemId || message.workItemId===command.workItemId);
          if(!correlated&&!uncorrelated)return;
          if(message.success===false)return finish(new Error(message.error ?? 'Minions command failed'));
          finish(null,Object.hasOwn(message,'result')?message.result:message);
        }catch(error){finish(error as Error);}
      });
      socket.addEventListener('error',()=>finish(new Error('Minions WS connection failed')));
    });
  }
  async http(path:string, init: {method?:string;body?:string} = {}):Promise<any> {
    const base=new URL(this.endpoint);base.protocol=base.protocol==='wss:'?'https:':'http:';
    const url=new URL(path,base);if(url.origin!==base.origin)throw new Error('cross-origin HTTP reference');
    const response=await fetch(url,{...init,headers:{...await this.headers(),'content-type':'application/json'},signal:AbortSignal.timeout(this.timeoutMs)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();
  }
  async history(sessionKey:string):Promise<any[]> {
    const base=new URL(this.endpoint); base.protocol=base.protocol==='wss:'?'https:':'http:';
    let before:number|null=null; const events:any[]=[]; const cursors=new Set<number>();
    do {
      const url=new URL(`/api/history/${encodeURIComponent(sessionKey)}`,base);url.searchParams.set('format','json');
      // Preserve explicit dedicated-instance authentication query (if configured).
      for(const [key,value] of base.searchParams)url.searchParams.set(key,value);
      if(before!==null)url.searchParams.set('before',String(before));
      const response=await fetch(url,{headers:await this.headers(),signal:AbortSignal.timeout(this.timeoutMs)});
      if(!response.ok)throw new Error(`history HTTP ${response.status}`);
      const page=await response.json() as any;
      for(const event of page.events ?? []) {
        if(event.historyRef?.url) {
          const exact=new URL(event.historyRef.url,base);
          if(exact.origin!==base.origin)throw new Error('cross-origin history reference');
          for(const [key,value] of base.searchParams)exact.searchParams.set(key,value);
          const raw=await fetch(exact,{headers:await this.headers(),signal:AbortSignal.timeout(this.timeoutMs)});if(!raw.ok)throw new Error(`event HTTP ${raw.status}`);
          events.push({...await raw.json() as object,historyId:event.historyId});
        } else events.push(event);
      }
      before=page.history?.before ?? null;
      if(before!==null){if(cursors.has(before))throw new Error('repeated history cursor');cursors.add(before);}
    }while(before!==null);
    return events.sort((a,b)=>(a.historyId??0)-(b.historyId??0));
  }
}

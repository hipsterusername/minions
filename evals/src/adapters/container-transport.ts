import { command, type ExecutionDescriptor } from './execution.js';
import { MinionsTransport } from './minions-transport.js';
/** The controller enters the owned network namespace; no host port or egress is opened. */
export class ContainerMinionsTransport extends MinionsTransport {
  constructor(endpoint:string, readonly execution:ExecutionDescriptor, timeoutMs=10000) { super(endpoint,timeoutMs); }
  private async invoke(method:string,args:unknown[]) {
    const source = `import {randomUUID} from 'node:crypto';\n${MinionsTransport.toString()}\nconst t=new MinionsTransport(${JSON.stringify(this.endpoint)},${this.timeoutMs});console.log(JSON.stringify(await t[${JSON.stringify(method)}](...${JSON.stringify(args)}))??'null');`;
    return JSON.parse(await command('docker',['exec',this.execution.containerName!,'node','--input-type=module','-e',source]));
  }
  override request(command:Record<string,unknown>,expected?:string) { return this.invoke('request',[command,expected]); }
  override async send(command:Record<string,unknown>) { await this.invoke('send',[command]); }
  override history(sessionKey:string) { return this.invoke('history',[sessionKey]); }
  override http(path:string,init: {method?:string;body?:string}={}) { return this.invoke('http',[path,init]); }
}

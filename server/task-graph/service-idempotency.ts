import { executeWorkItemCommand,findCommandResult } from "../work-item-command-ledger.ts";
import { TaskGraphConflictError } from "./errors.ts";
import type { TaskGraphService } from "./service.ts";

export function executeTaskGraphCommand<T>(service:TaskGraphService,input:{requestId:string;
  workItemId:string;command:string;payload:unknown;resultKey?:string},mutate:()=>T):{
    idempotent:boolean;value:T|null
  } {
  try {
    const result=executeWorkItemCommand(service.options.db,{...input,at:service.now()},mutate);
    return {idempotent:result.idempotent,value:result.value};
  } catch (error) {
    if (error instanceof Error && error.message.includes("idempotency request was reused")) {
      throw new TaskGraphConflictError("task-graph request id was reused with different input");
    }
    throw error;
  }
}

export function isTaskGraphCommandReplay(service:TaskGraphService,input:{requestId:string;
  command:string;payload:unknown}):boolean {
  try { return findCommandResult(service.options.db,input)!==undefined; }
  catch (error) {
    if (error instanceof Error && error.message.includes("idempotency request was reused")) {
      throw new TaskGraphConflictError("task-graph request id was reused with different input");
    }
    throw error;
  }
}

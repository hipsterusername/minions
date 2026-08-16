import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult,textResult } from "../harness/tool-result.ts";
import { hashSchema } from "../../shared/task-graph-contracts.ts";
import type { TaskGraphService } from "./service.ts";
import { readTaskGraphArtifactForSession,taskGraphArtifactsForSession } from "./artifact-access.ts";

const stageInputSchema = z.object({
  outputName:z.string().min(1),schemaName:z.string().min(1),schemaVersion:z.string().min(1),
  contentHash:hashSchema,storageRef:z.string().min(1),byteSize:z.number().int().nonnegative(),
  classification:z.enum(["public","internal","sensitive","secret"]),
  retentionPolicy:z.string().min(1),observedWriteSet:z.array(z.string()).default([]),
});
const readInputSchema=z.object({artifactId:z.string().min(1),offset:z.number().int().nonnegative().default(0),
  maxBytes:z.number().int().min(1).max(262_144).default(65_536)});

export function createTaskGraphAgentTools(service: TaskGraphService,sessionRunKey:string): NormalizedToolDef[] {
  const binding = service.agentBinding(sessionRunKey);
  const readable=taskGraphArtifactsForSession(service,sessionRunKey);
  const tools:NormalizedToolDef[]=[];
  if (readable.length) tools.push({name:"read_input_artifact",
    description:"Read a bounded chunk of an immutable artifact authorized for this graph attempt or verifier. Use nextOffset to continue; secret artifacts are never copied into agent context.",
    inputSchema:readInputSchema,
    handler:async(raw)=>jsonResult(readTaskGraphArtifactForSession(service,sessionRunKey,
      readInputSchema.parse(raw))),
  });
  if (binding && Object.keys(binding.outputSchemas).length>0) tools.push({ name:"stage_output_artifact",
    description:"Stage one declared graph output as immutable evidence before reporting done. The content hash must be sha256:<64 lowercase hex>; storageRef must identify the durable file, patch, or artifact location.",
    inputSchema:stageInputSchema,
    handler:async(raw) => {
      const input = stageInputSchema.parse(raw);
      const result = service.stageArtifactForSession(sessionRunKey,input);
      return textResult(result.staged
        ? `Staged ${input.outputName} as ${result.artifactId}.`
        : `Artifact ${result.artifactId} was already staged.`);
    },
  });
  return tools;
}

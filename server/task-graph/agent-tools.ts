import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult,textResult } from "../harness/tool-result.ts";
import { artifactStageInputSchema,artifactStageMetadataSchema,
  inlineArtifactStageInputSchema } from "../../shared/task-graph-contracts.ts";
import type { TaskGraphService } from "./service.ts";
import { readTaskGraphArtifactForSession,taskGraphArtifactsForSession } from "./artifact-access.ts";

const readInputSchema=z.object({artifactId:z.string().min(1),offset:z.number().int().nonnegative().default(0),
  maxBytes:z.number().int().min(1).max(262_144).default(65_536)});
const writableArtifactStageInputSchema=artifactStageMetadataSchema.extend({
  source:z.enum(["inline","path"]),
  inlineJson:z.json().optional(),
  storageRef:z.string().min(1).optional(),
}).strict().superRefine((value,ctx)=>{
  if (value.source==="inline" && value.inlineJson===undefined) {
    ctx.addIssue({code:"custom",path:["inlineJson"],message:"inlineJson is required for inline artifacts"});
  }
  if (value.source==="path" && value.storageRef===undefined) {
    ctx.addIssue({code:"custom",path:["storageRef"],message:"storageRef is required for path artifacts"});
  }
  if (value.source==="inline" && value.storageRef!==undefined) {
    ctx.addIssue({code:"custom",path:["storageRef"],message:"storageRef is not allowed for inline artifacts"});
  }
  if (value.source==="path" && value.inlineJson!==undefined) {
    ctx.addIssue({code:"custom",path:["inlineJson"],message:"inlineJson is not allowed for path artifacts"});
  }
});

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
  if (binding && Object.keys(binding.outputSchemas).length>0) {
    const writes=binding.ownershipRequest.some(scope=>scope.mode==="write");
    // All harness adapters require an object-shaped tool contract. Keep the
    // canonical discriminated union in the handler, not at the tool boundary.
    const stageInputSchema=writes?writableArtifactStageInputSchema:inlineArtifactStageInputSchema;
    tools.push({ name:"stage_output_artifact",
    description:writes
      ? "Stage one declared graph output as immutable evidence. Choose exactly one source: inline with inlineJson, or path with a workspace-relative storageRef. The server derives hash and byte size; optional supplied values are treated as integrity guards."
      : "Stage one declared graph output as immutable evidence using inline JSON. Set source to inline and provide inlineJson; the server serializes, hashes, sizes, validates, and stores it. Path-backed staging requires write ownership and is unavailable to this read-only node.",
    inputSchema:stageInputSchema,
    handler:async(raw) => {
      const input = artifactStageInputSchema.parse(stageInputSchema.parse(raw));
      const result = service.stageArtifactForSession(sessionRunKey,input);
      return textResult(result.staged
        ? `Staged ${input.outputName} as ${result.artifactId}.`
        : `Artifact ${result.artifactId} was already staged.`);
    },
  });
  }
  return tools;
}

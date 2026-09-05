import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { artifactStageInputSchema,type ArtifactInput,type ArtifactStageInput,
  type TaskNode, type GraphRevisionInput } from "../../shared/task-graph-contracts.ts";
import { getMinionsHome } from "../workspace-registry.ts";
import { TaskGraphValidationError } from "./errors.ts";
import {validateArtifactContract} from "./artifact-contract.ts";

export const MAX_ARTIFACT_BYTES=50*1024*1024;
export const MAX_INLINE_ARTIFACT_BYTES=256*1024;
const MAX_ARTIFACT_CHUNK_BYTES=256*1024;

export interface TaskGraphArtifactChunk {
  byteSize:number;
  offset:number;
  nextOffset:number|null;
  encoding:"utf8"|"base64";
  content:string;
}

type UnverifiedArtifactMetadata = Omit<ArtifactInput,"id"|"contentHash"|"byteSize"> & {
  contentHash?:string;
  byteSize?:number;
};

/** Bind a staging source to node authority before touching workspace paths. */
export function storeTaskGraphArtifactForNode(db:Database.Database,runId:string,node:TaskNode,
  rawInput:ArtifactStageInput,spec?:GraphRevisionInput):Omit<ArtifactInput,"id"> {
  const input=artifactStageInputSchema.parse(rawInput);
  if (!(input.outputName in node.outputSchemas)) throw new TaskGraphValidationError(
    `$.outputName: expected one of ${JSON.stringify(Object.keys(node.outputSchemas))}; received ${JSON.stringify(input.outputName)}. Choose a declared output and restage; the rejected draft did not consume an output slot.`,
  );
  const schema=node.outputSchemas[input.outputName];
  const contracts=spec?.edges.filter(edge=>edge.sourceNodeId===node.id && edge.sourceOutput===input.outputName
    && (edge.kind==="artifact" || edge.kind==="verified_artifact"))
    .map(edge=>spec.nodes.find(consumer=>consumer.id===edge.targetNodeId)!.inputBindings[edge.targetInput!]) ?? [];
  if (input.source==="inline") return storeInlineTaskGraphArtifact(input,schema,contracts);
  const storageRef=canonicalArtifactStorageRef(input.storageRef);
  const declaredScopes=node.ownershipRequest
    .filter(scope=>scope.scope==="path" && scope.mode==="write")
    .map(scope=>scope.normalizedValue);
  const matchingScopes=declaredScopes
    .filter(scope=>storageRef===scope || storageRef.startsWith(`${scope}/`));
  if (matchingScopes.length===0) {
    throw new TaskGraphValidationError("path-backed artifact storageRef exceeds write ownership");
  }
  const workItem=db.prepare(`SELECT w.project_path FROM task_graph_runs g
    JOIN work_items w ON w.id=g.work_item_id WHERE g.id=?`).get(runId) as {project_path:unknown}|undefined;
  if (!workItem) throw new TaskGraphValidationError("graph workspace authority is unavailable");
  const {source:_source,...pathInput}=input;
  const observedWriteSet=[...new Set([...pathInput.observedWriteSet,storageRef])];
  return storeTaskGraphArtifact(String(workItem.project_path),
    {...pathInput,storageRef,observedWriteSet},schema,matchingScopes,contracts);
}

/** Verify an agent-owned file and copy it into immutable content-addressed storage. */
export function storeTaskGraphArtifact(workspaceRoot:string,input:UnverifiedArtifactMetadata,
  declaredOutputSchema:unknown,ownedStorageRefs:string[],contracts:unknown[]=[]): Omit<ArtifactInput,"id"> {
  const source=canonicalWorkspaceFile(workspaceRoot,input.storageRef,ownedStorageRefs);
  const bytes=readBoundedStableFile(source);
  return storeVerifiedBytes(input,bytes,declaredOutputSchema,contracts);
}

/** Serialize bounded agent-supplied JSON and copy it into immutable content-addressed storage. */
export function storeInlineTaskGraphArtifact(input:Extract<ArtifactStageInput,{source:"inline"}>,
  declaredOutputSchema:unknown,contracts:unknown[]=[]):Omit<ArtifactInput,"id"> {
  const bytes=Buffer.from(JSON.stringify(input.inlineJson),"utf8");
  if (bytes.length>MAX_INLINE_ARTIFACT_BYTES) {
    throw new TaskGraphValidationError("inline artifact exceeds the 256 KiB limit");
  }
  const {source:_source,inlineJson:_inlineJson,...metadata}=input;
  return storeVerifiedBytes({...metadata,storageRef:""},bytes,declaredOutputSchema,contracts);
}

function storeVerifiedBytes(input:UnverifiedArtifactMetadata,bytes:Buffer,
  declaredOutputSchema:unknown,contracts:unknown[]=[]):Omit<ArtifactInput,"id"> {
  if (input.byteSize!==undefined && bytes.length!==input.byteSize) {
    throw new TaskGraphValidationError("artifact byteSize does not match stored content");
  }
  const actual=`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  if (input.contentHash!==undefined && actual!==input.contentHash) {
    throw new TaskGraphValidationError("artifact contentHash does not match stored content");
  }
  validateDeclaredOutput(bytes,declaredOutputSchema);
  for (const contract of contracts) validateDeclaredOutput(bytes,contract);
  const root=path.join(getMinionsHome(),"artifacts","task-graph");
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const rootStat=fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new TaskGraphValidationError("task-graph artifact root is unsafe");
  }
  const rootReal=fs.realpathSync(root);
  const destination=path.join(rootReal,actual.slice("sha256:".length));
  try { fs.writeFileSync(destination,bytes,{flag:"wx",mode:0o600}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
    const existing=fs.readFileSync(destination);
    const existingHash=`sha256:${crypto.createHash("sha256").update(existing).digest("hex")}`;
    if (existingHash!==actual) throw new TaskGraphValidationError("content-addressed artifact collision");
  }
  const destinationStat=fs.lstatSync(destination);
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink()
    || path.dirname(fs.realpathSync(destination))!==rootReal) {
    throw new TaskGraphValidationError("content-addressed artifact target is unsafe");
  }
  fs.chmodSync(destination,0o400);
  return {...input,contentHash:actual,byteSize:bytes.length,storageRef:destination};
}

/** Validate JSON bytes with Ajv's standards-compatible JSON Schema draft-07 implementation. */
function validateDeclaredOutput(bytes:Buffer,declaredOutputSchema:unknown):void {
  let value:unknown;
  try { value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); }
  catch { throw new TaskGraphValidationError("artifact content must be valid UTF-8 JSON"); }
  validateArtifactContract(value,declaredOutputSchema);
}

/** Read a bounded chunk only after revalidating canonical storage and content identity. */
export function readStoredTaskGraphArtifact(input:{storageRef:string;contentHash:string;byteSize:number;
  offset:number;maxBytes:number;contract?:unknown}):TaskGraphArtifactChunk {
  if (!Number.isInteger(input.offset) || input.offset<0 || input.offset>input.byteSize) {
    throw new TaskGraphValidationError("artifact offset is outside the immutable content");
  }
  if (!Number.isInteger(input.maxBytes) || input.maxBytes<1 || input.maxBytes>MAX_ARTIFACT_CHUNK_BYTES) {
    throw new TaskGraphValidationError("artifact maxBytes must be between 1 and 262144");
  }
  const root=path.join(getMinionsHome(),"artifacts","task-graph");
  let rootReal:string;let storedReal:string;
  try { rootReal=fs.realpathSync(root);storedReal=fs.realpathSync(input.storageRef); }
  catch { throw new TaskGraphValidationError("immutable artifact content is unavailable"); }
  const stat=fs.lstatSync(storedReal);
  if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(storedReal)!==rootReal
    || path.basename(storedReal)!==input.contentHash.slice("sha256:".length)
    || stat.size!==input.byteSize) {
    throw new TaskGraphValidationError("immutable artifact storage binding is invalid");
  }
  const bytes=fs.readFileSync(storedReal);
  const actual=`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  if (actual!==input.contentHash) throw new TaskGraphValidationError("immutable artifact content hash changed");
  if (input.contract !== undefined) validateDeclaredOutput(bytes, input.contract);
  const end=Math.min(bytes.length,input.offset+input.maxBytes);
  const chunk=bytes.subarray(input.offset,end);
  let encoding:"utf8"|"base64"="utf8";let content:string;
  try { content=new TextDecoder("utf-8",{fatal:true}).decode(chunk); }
  catch { encoding="base64";content=chunk.toString("base64"); }
  return {byteSize:bytes.length,offset:input.offset,nextOffset:end<bytes.length?end:null,encoding,content};
}

function readBoundedStableFile(source:string):Buffer {
  let fd:number|undefined;
  try {
    fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const before=fs.fstatSync(fd,{bigint:true});
    if (!before.isFile()) throw new TaskGraphValidationError("artifact storageRef must identify a regular file");
    if (before.size>BigInt(MAX_ARTIFACT_BYTES)) {
      throw new TaskGraphValidationError("artifact exceeds the 50 MiB limit");
    }
    const capture=Buffer.allocUnsafe(Number(before.size)+1);
    let captured=0;
    while (captured<capture.length) {
      const count=fs.readSync(fd,capture,captured,capture.length-captured,captured);
      if (count===0) break;
      captured+=count;
    }
    if (captured>MAX_ARTIFACT_BYTES) {
      throw new TaskGraphValidationError("artifact exceeds the 50 MiB limit");
    }
    const after=fs.fstatSync(fd,{bigint:true});
    if (after.size>BigInt(MAX_ARTIFACT_BYTES)) {
      throw new TaskGraphValidationError("artifact exceeds the 50 MiB limit");
    }
    if (captured!==Number(before.size) || after.dev!==before.dev || after.ino!==before.ino
      || after.size!==before.size || after.mtimeNs!==before.mtimeNs || after.ctimeNs!==before.ctimeNs) {
      throw new TaskGraphValidationError("artifact changed while being captured");
    }
    return capture.subarray(0,captured);
  } catch (error) {
    if (error instanceof TaskGraphValidationError) throw error;
    throw new TaskGraphValidationError("artifact storageRef could not be captured safely");
  } finally {
    if (fd!==undefined) fs.closeSync(fd);
  }
}

function canonicalWorkspaceFile(workspaceRoot:string,storageRef:string,ownedStorageRefs:string[]): string {
  const normalized=canonicalArtifactStorageRef(storageRef);
  let rootReal:string;let sourceReal:string;
  try { rootReal=fs.realpathSync(path.resolve(workspaceRoot));sourceReal=fs.realpathSync(path.resolve(rootReal,normalized)); }
  catch { throw new TaskGraphValidationError("artifact storageRef does not exist"); }
  const relative=path.relative(rootReal,sourceReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TaskGraphValidationError("artifact storageRef escapes the workspace");
  }
  const withinOwnedScope=ownedStorageRefs.some(scope=>{
    const normalizedScope=canonicalArtifactStorageRef(scope);
    if (normalized!==normalizedScope && !normalized.startsWith(`${normalizedScope}/`)) return false;
    try {
      const scopeReal=fs.realpathSync(path.resolve(rootReal,normalizedScope));
      const scopeFromWorkspace=path.relative(rootReal,scopeReal);
      if (scopeFromWorkspace.startsWith("..") || path.isAbsolute(scopeFromWorkspace)) return false;
      const sourceFromScope=path.relative(scopeReal,sourceReal);
      return sourceFromScope==="" || (!sourceFromScope.startsWith("..") && !path.isAbsolute(sourceFromScope));
    } catch { return false; }
  });
  if (!withinOwnedScope) {
    throw new TaskGraphValidationError("path-backed artifact storageRef exceeds canonical write ownership");
  }
  return sourceReal;
}

function canonicalArtifactStorageRef(storageRef:string):string {
  if (!storageRef || path.isAbsolute(storageRef) || storageRef.includes("\\")) {
    throw new TaskGraphValidationError("artifact storageRef must be a canonical relative path");
  }
  const normalized=path.posix.normalize(storageRef);
  if (normalized!==storageRef || normalized===".." || normalized.startsWith("../")
    || /[*?\[\]{}]/.test(normalized)) {
    throw new TaskGraphValidationError("artifact storageRef must be a canonical relative path");
  }
  return normalized;
}

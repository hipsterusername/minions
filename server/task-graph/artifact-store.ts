import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactInput } from "../../shared/task-graph-contracts.ts";
import { getMinionsHome } from "../workspace-registry.ts";
import { TaskGraphValidationError } from "./errors.ts";

const MAX_ARTIFACT_BYTES=50*1024*1024;
const MAX_ARTIFACT_CHUNK_BYTES=256*1024;

export interface TaskGraphArtifactChunk {
  byteSize:number;
  offset:number;
  nextOffset:number|null;
  encoding:"utf8"|"base64";
  content:string;
}

/** Verify an agent-owned file and copy it into immutable content-addressed storage. */
export function storeTaskGraphArtifact(workspaceRoot:string,input:Omit<ArtifactInput,"id">): Omit<ArtifactInput,"id"> {
  const source=canonicalWorkspaceFile(workspaceRoot,input.storageRef);
  const stat=fs.statSync(source);
  if (!stat.isFile()) throw new TaskGraphValidationError("artifact storageRef must identify a regular file");
  if (stat.size>MAX_ARTIFACT_BYTES) throw new TaskGraphValidationError("artifact exceeds the 50 MiB limit");
  if (stat.size!==input.byteSize) throw new TaskGraphValidationError("artifact byteSize does not match stored content");
  const bytes=fs.readFileSync(source);
  const actual=`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  if (actual!==input.contentHash) throw new TaskGraphValidationError("artifact contentHash does not match stored content");

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
  return {...input,storageRef:destination};
}

/** Read a bounded chunk only after revalidating canonical storage and content identity. */
export function readStoredTaskGraphArtifact(input:{storageRef:string;contentHash:string;byteSize:number;
  offset:number;maxBytes:number}):TaskGraphArtifactChunk {
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
  const end=Math.min(bytes.length,input.offset+input.maxBytes);
  const chunk=bytes.subarray(input.offset,end);
  let encoding:"utf8"|"base64"="utf8";let content:string;
  try { content=new TextDecoder("utf-8",{fatal:true}).decode(chunk); }
  catch { encoding="base64";content=chunk.toString("base64"); }
  return {byteSize:bytes.length,offset:input.offset,nextOffset:end<bytes.length?end:null,encoding,content};
}

function canonicalWorkspaceFile(workspaceRoot:string,storageRef:string): string {
  if (!storageRef || path.isAbsolute(storageRef) || storageRef.includes("\\")) {
    throw new TaskGraphValidationError("artifact storageRef must be a canonical relative path");
  }
  const normalized=path.posix.normalize(storageRef);
  if (normalized!==storageRef || normalized===".." || normalized.startsWith("../")
    || /[*?\[\]{}]/.test(normalized)) {
    throw new TaskGraphValidationError("artifact storageRef must be a canonical relative path");
  }
  let rootReal:string;let sourceReal:string;
  try { rootReal=fs.realpathSync(path.resolve(workspaceRoot));sourceReal=fs.realpathSync(path.resolve(rootReal,normalized)); }
  catch { throw new TaskGraphValidationError("artifact storageRef does not exist"); }
  const relative=path.relative(rootReal,sourceReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TaskGraphValidationError("artifact storageRef escapes the workspace");
  }
  return sourceReal;
}

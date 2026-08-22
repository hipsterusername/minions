import { makeTaskGraphTempDir, taskGraphTestHome } from "./test-helpers.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe,expect,it,vi } from "vitest";
import { TaskGraphValidationError } from "./errors.ts";
import { MAX_ARTIFACT_BYTES,MAX_INLINE_ARTIFACT_BYTES,readStoredTaskGraphArtifact,storeInlineTaskGraphArtifact,
  storeTaskGraphArtifact } from "./artifact-store.ts";

describe("task graph artifact store",() => {
  it("verifies and snapshots a workspace file by content hash",() => {
    const workspace=makeTaskGraphTempDir("graph-workspace-");
    const bytes=Buffer.from('{"result":"immutable"}');
    fs.writeFileSync(path.join(workspace,"result.txt"),bytes);
    const hash=`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const stored=storeTaskGraphArtifact(workspace,{outputName:"result",schemaName:"Text",schemaVersion:"1",
      contentHash:hash,storageRef:"result.txt",byteSize:bytes.length,classification:"internal",
      retentionPolicy:"keep",observedWriteSet:[]},{type:"object",required:["result"]},["result.txt"]);
    fs.writeFileSync(path.join(workspace,"result.txt"),"changed");

    expect(stored.storageRef).toContain(path.join(taskGraphTestHome,"artifacts","task-graph"));
    expect(fs.readFileSync(stored.storageRef,"utf8")).toBe('{"result":"immutable"}');
    expect(readStoredTaskGraphArtifact({...stored,offset:0,maxBytes:9})).toMatchObject({
      content:'{"result"',encoding:"utf8",offset:0,nextOffset:9,byteSize:bytes.length,
    });
    expect(()=>readStoredTaskGraphArtifact({...stored,offset:bytes.length+1,maxBytes:1}))
      .toThrow(TaskGraphValidationError);
  });

  it("rejects false hashes and workspace escapes",() => {
    const workspace=makeTaskGraphTempDir("graph-workspace-");
    fs.writeFileSync(path.join(workspace,"result.txt"),"result");
    const base={outputName:"result",schemaName:"Text",schemaVersion:"1",
      contentHash:`sha256:${"a".repeat(64)}`,byteSize:6,classification:"internal" as const,
      retentionPolicy:"keep",observedWriteSet:[]};
    expect(()=>storeTaskGraphArtifact(workspace,{...base,storageRef:"result.txt"},{type:"string"},["result.txt"]))
      .toThrow(TaskGraphValidationError);
    expect(()=>storeTaskGraphArtifact(workspace,{...base,storageRef:"../outside"},{type:"string"},["."]))
      .toThrow(TaskGraphValidationError);
  });

  it("rejects an in-workspace symlink that crosses the canonical owned root",()=>{
    const workspace=makeTaskGraphTempDir("graph-workspace-");
    fs.mkdirSync(path.join(workspace,"owned"));
    fs.mkdirSync(path.join(workspace,"unowned"));
    fs.writeFileSync(path.join(workspace,"unowned","result.json"),'{"result":"outside ownership"}');
    fs.symlinkSync(path.join("..","unowned","result.json"),path.join(workspace,"owned","link.json"));

    expect(()=>storeTaskGraphArtifact(workspace,{storageRef:"owned/link.json",outputName:"result",
      schemaName:"Result",schemaVersion:"1",classification:"internal",retentionPolicy:"keep",
      observedWriteSet:[]},{type:"object",required:["result"]},["owned"]))
      .toThrow("exceeds canonical write ownership");
  });

  it("rejects growth beyond the immutable size bound during descriptor capture",()=>{
    const workspace=makeTaskGraphTempDir("graph-workspace-");
    const source=path.join(workspace,"result.json");
    fs.writeFileSync(source,'{"result":"small"}');
    const readSync=fs.readSync.bind(fs);
    const read=vi.spyOn(fs,"readSync").mockImplementation((...args:Parameters<typeof fs.readSync>)=>{
      fs.truncateSync(source,MAX_ARTIFACT_BYTES+1);
      return readSync(...args);
    });
    try {
      expect(()=>storeTaskGraphArtifact(workspace,{storageRef:"result.json",outputName:"result",
        schemaName:"Result",schemaVersion:"1",classification:"internal",retentionPolicy:"keep",
        observedWriteSet:[]},{type:"object"},["result.json"]))
        .toThrow("artifact exceeds the 50 MiB limit");
    } finally { read.mockRestore(); }
  });

  it("stores bounded inline JSON with exact hash, size, and schema validation",()=>{
    const inlineJson={result:"server mediated"};
    const bytes=Buffer.from(JSON.stringify(inlineJson));
    const contentHash=`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const input={source:"inline" as const,inlineJson,outputName:"result",schemaName:"Result",
      schemaVersion:"1",contentHash,byteSize:bytes.length,classification:"internal" as const,
      retentionPolicy:"keep",observedWriteSet:[]};
    const stored=storeInlineTaskGraphArtifact(input,{type:"object",required:["result"],
      properties:{result:{type:"string"}}});

    expect(stored.storageRef).toContain(path.join(taskGraphTestHome,"artifacts","task-graph"));
    expect(fs.readFileSync(stored.storageRef)).toEqual(bytes);
    expect(fs.statSync(stored.storageRef).mode&0o777).toBe(0o400);
    expect(()=>storeInlineTaskGraphArtifact({...input,byteSize:bytes.length+1},{type:"object"}))
      .toThrow("byteSize does not match");
    expect(()=>storeInlineTaskGraphArtifact({...input,contentHash:`sha256:${"a".repeat(64)}`},
      {type:"object"})).toThrow("contentHash does not match");
    expect(()=>storeInlineTaskGraphArtifact({...input,inlineJson:{result:7},
      byteSize:JSON.stringify({result:7}).length,
      contentHash:`sha256:${crypto.createHash("sha256").update(JSON.stringify({result:7})).digest("hex")}`},
      {type:"object",properties:{result:{type:"string"}}})).toThrow("does not satisfy declared output schema");
  });

  it("derives integrity metadata for minimal inline staging input",()=>{
    const inlineJson={result:"server owned"};
    const bytes=Buffer.from(JSON.stringify(inlineJson));
    const stored=storeInlineTaskGraphArtifact({source:"inline",inlineJson,outputName:"result",
      schemaName:"GraphOutput",schemaVersion:"1",classification:"internal",
      retentionPolicy:"graph-run",observedWriteSet:[]},{type:"object",required:["result"]});

    expect(stored).toMatchObject({
      contentHash:`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
      byteSize:bytes.length,
      schemaName:"GraphOutput",schemaVersion:"1",classification:"internal",
      retentionPolicy:"graph-run",outputName:"result",
    });
  });

  it("rejects inline JSON beyond the transport bound before durable storage",()=>{
    const inlineJson="x".repeat(MAX_INLINE_ARTIFACT_BYTES);
    const bytes=Buffer.from(JSON.stringify(inlineJson));
    const contentHash=`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    expect(()=>storeInlineTaskGraphArtifact({source:"inline",inlineJson,outputName:"result",
      schemaName:"Result",schemaVersion:"1",contentHash,byteSize:bytes.length,
      classification:"internal",retentionPolicy:"keep",observedWriteSet:[]},{type:"string"}))
      .toThrow("inline artifact exceeds the 256 KiB limit");
    expect(fs.existsSync(path.join(taskGraphTestHome,"artifacts","task-graph",
      contentHash.slice("sha256:".length)))).toBe(false);
  });
});

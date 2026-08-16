import { makeTaskGraphTempDir, taskGraphTestHome } from "./test-helpers.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { TaskGraphValidationError } from "./errors.ts";
import { readStoredTaskGraphArtifact,storeTaskGraphArtifact } from "./artifact-store.ts";

describe("task graph artifact store",() => {
  it("verifies and snapshots a workspace file by content hash",() => {
    const workspace=makeTaskGraphTempDir("graph-workspace-");
    const bytes=Buffer.from("immutable result\n");
    fs.writeFileSync(path.join(workspace,"result.txt"),bytes);
    const hash=`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const stored=storeTaskGraphArtifact(workspace,{outputName:"result",schemaName:"Text",schemaVersion:"1",
      contentHash:hash,storageRef:"result.txt",byteSize:bytes.length,classification:"internal",
      retentionPolicy:"keep",observedWriteSet:[]});
    fs.writeFileSync(path.join(workspace,"result.txt"),"changed");

    expect(stored.storageRef).toContain(path.join(taskGraphTestHome,"artifacts","task-graph"));
    expect(fs.readFileSync(stored.storageRef,"utf8")).toBe("immutable result\n");
    expect(readStoredTaskGraphArtifact({...stored,offset:0,maxBytes:9})).toMatchObject({
      content:"immutable",encoding:"utf8",offset:0,nextOffset:9,byteSize:bytes.length,
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
    expect(()=>storeTaskGraphArtifact(workspace,{...base,storageRef:"result.txt"}))
      .toThrow(TaskGraphValidationError);
    expect(()=>storeTaskGraphArtifact(workspace,{...base,storageRef:"../outside"}))
      .toThrow(TaskGraphValidationError);
  });
});

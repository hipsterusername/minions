import { describe, expect, it } from "vitest";
import { UsageLedger, normalizeUsage } from "./usage.js";

describe("usage normalization", () => {
  it("calibrates raw Codex and Minions ordinary input to the same totals", () => {
    const codex = normalizeUsage({ sourceId: "a", participantId: "p", turnId: "t", kind: "turn_snapshot", semantics: "codex_raw", input: 17, output: 5, cacheRead: 4, cacheWrite: 3 });
    const minions = normalizeUsage({ sourceId: "b", participantId: "p", turnId: "t", kind: "turn_snapshot", semantics: "minions_codex", input: 10, output: 5, cacheRead: 4, cacheWrite: 3 });
    expect(codex).toMatchObject({ inputTokensTotal: 17, inputTokensUncached: 10, totalTokens: 22 });
    expect(minions).toMatchObject({ inputTokensTotal: 17, inputTokensUncached: 10, totalTokens: 22 });
  });
  it("replaces duplicate/corrected source observations and identifies absent descendants", () => {
    const ledger = new UsageLedger();
    ledger.ingest({ sourceId: "turn", revision: 1, participantId: "leader", turnId: "1", kind: "delta", semantics: "codex_raw", input: 5, output: 2 });
    ledger.ingest({ sourceId: "turn", revision: 2, participantId: "leader", turnId: "1", kind: "delta", semantics: "codex_raw", input: 7, output: 3 });
    ledger.ingest({ sourceId: "turn-2", participantId: "leader", turnId: "2", kind: "turn_snapshot", semantics: "codex_raw", input: 2, output: 1, cacheRead: 1 });
    const result = ledger.aggregate(["leader", "child"]);
    expect(result.usage).toMatchObject({ totalTokens: 13, cacheReadTokens: 1, coverage: "partial" });
    expect(result.reasons).toContain("missing usage for participant child");
  });
  it("keeps only the corrected cumulative session snapshot after reconnect", () => {
    const ledger = new UsageLedger();
    ledger.ingest({ sourceId: "session", participantId: "p", turnId: null, kind: "cumulative_session", semantics: "codex_raw", input: 10, output: 2 });
    expect(ledger.aggregate().usage?.totalTokens).toBe(12);
    ledger.ingest({ sourceId: "session", revision: 2, participantId: "p", turnId: null, kind: "cumulative_session", semantics: "codex_raw", input: 16, output: 4 });
    expect(ledger.aggregate().usage?.totalTokens).toBe(20);
  });
});

it('reconciles sequential cumulative IDs and covered turn snapshots without double counting costs',()=>{
  const ledger=new UsageLedger();
  const base={participantId:'p',turnId:null,semantics:'codex_raw' as const,input:10,output:2,reportedCostUSD:0.2};
  ledger.ingest({...base,sourceId:'turn',turnId:'t',kind:'turn_snapshot',sequence:1});
  ledger.ingest({...base,sourceId:'snapshot-1',kind:'cumulative_session',sequence:2,coversThroughSequence:1});
  ledger.ingest({...base,sourceId:'snapshot-2',kind:'cumulative_session',sequence:4,coversThroughSequence:3,input:20,output:4,reportedCostUSD:0.4});
  ledger.ingest({...base,sourceId:'later',turnId:'later',kind:'turn_snapshot',sequence:5});
  expect(ledger.aggregate(['p']).usage).toMatchObject({totalTokens:36,coverage:'complete'});
  expect(ledger.aggregate(['p']).usage?.reportedCostUSD).toBeCloseTo(0.6);
});
it('keeps identical counts in distinct turns, corrections, zero cost and missing descendant coverage',()=>{
  const ledger=new UsageLedger();
  for(const turnId of ['1','2'])ledger.ingest({participantId:'p',turnId,sourceId:'turn',kind:'turn_snapshot',semantics:'codex_raw',input:10,output:2,reportedCostUSD:0});
  expect(ledger.aggregate().usage).toMatchObject({totalTokens:24,reportedCostUSD:0});
  expect(ledger.aggregate(['p','failed-child']).coverage).toBe('partial');
  ledger.ingest({participantId:'p',turnId:'2',sourceId:'turn',revision:2,kind:'turn_snapshot',semantics:'codex_raw',input:11,output:3,coverage:'partial',coverageReasons:['aborted final usage unavailable']});
  expect(ledger.aggregate().usage).toMatchObject({totalTokens:26,reportedCostUSD:null,coverage:'partial'});
});
it('does not label ambiguous turn/session overlap complete or clamp invalid cache categories',()=>{
  const ledger=new UsageLedger();
  for(const kind of ['turn_snapshot','cumulative_session'] as const)ledger.ingest({participantId:'p',turnId:kind==='turn_snapshot'?'t':null,sourceId:kind,kind,semantics:'codex_raw',input:10,output:2});
  expect(ledger.aggregate()).toMatchObject({coverage:'partial',reasons:['ambiguous turn/session coverage interval']});
  expect(()=>normalizeUsage({participantId:'p',turnId:'t',sourceId:'x',kind:'delta',semantics:'codex_raw',input:3,output:1,cacheRead:4})).toThrow('overlap');
});

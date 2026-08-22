import {describe,expect,it} from "vitest";
import {hasPassedVerificationTaskWitness,parseVerificationTaskVerdict} from "./verification-verdict.ts";

describe("parseVerificationTaskVerdict",()=>{
  it.each(["passed","failed","inconclusive"] as const)("accepts an explicit %s JSON verdict",result=>{
    expect(parseVerificationTaskVerdict(JSON.stringify({result,confidence:0.8}),"completed"))
      .toEqual({result,confidence:0.8});
  });

  it.each([
    null,
    "verification failed",
    JSON.stringify({result:"passed"}),
    JSON.stringify({result:"passed",confidence:2}),
    JSON.stringify({result:"passed",confidence:1,unexpected:true}),
  ])("fails closed for missing or malformed verdict evidence",report=>{
    expect(parseVerificationTaskVerdict(report,"completed"))
      .toEqual({result:"inconclusive",confidence:0});
  });

  it("fails closed when the child did not complete",()=>{
    expect(parseVerificationTaskVerdict(JSON.stringify({result:"passed",confidence:1}),"error"))
      .toEqual({result:"inconclusive",confidence:0});
  });

  it("accepts only a passed verdict bound to the attempt's child run",()=>{
    const attempt={session_run_key:"child",terminal_witness_json:JSON.stringify({
      source:"work_item_run",runKey:"child",
      finalReport:JSON.stringify({result:"passed",confidence:1}),
      completionVerdict:{result:"passed",confidence:1},
    })};
    expect(hasPassedVerificationTaskWitness(attempt)).toBe(true);
    expect(hasPassedVerificationTaskWitness({...attempt,session_run_key:"other"})).toBe(false);
    expect(hasPassedVerificationTaskWitness({...attempt,terminal_witness_json:JSON.stringify({
      source:"work_item_run",runKey:"child",
      finalReport:JSON.stringify({result:"failed",confidence:1}),
      completionVerdict:{result:"passed",confidence:1},
    })})).toBe(false);
  });
});

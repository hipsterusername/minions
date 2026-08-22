import type { WorkItemRunSnapshot } from "../../shared/work-item-contracts.ts";
import {
  verificationTaskVerdictSchema,
  type VerificationTaskVerdict,
} from "../../shared/task-graph-contracts.ts";

export function parseVerificationTaskVerdict(
  report:string|null,
  outcome:WorkItemRunSnapshot["outcome"],
):VerificationTaskVerdict {
  if (outcome !== "completed" || !report) return inconclusiveVerdict();
  try {
    const candidate=JSON.parse(report) as unknown;
    const normalized=candidate && typeof candidate==="object" && !Array.isArray(candidate)
      && typeof (candidate as Record<string,unknown>)["summary"]==="string"
      ? {...candidate as Record<string,unknown>,summary:
        (candidate as Record<string,unknown>)["summary"]!.toString().trim().slice(0,1_000)}
      : candidate;
    const parsed=verificationTaskVerdictSchema.safeParse(normalized);
    return parsed.success ? parsed.data : inconclusiveVerdict();
  } catch {
    return inconclusiveVerdict();
  }
}

export function hasPassedVerificationTaskWitness(attempt:Record<string,unknown>):boolean {
  const raw=attempt["terminal_witness_json"]??attempt["terminalWitness"];
  let witness:Record<string,unknown>;
  try {
    const parsed=typeof raw==="string" ? JSON.parse(raw) as unknown : raw;
    if (!parsed || typeof parsed!=="object" || Array.isArray(parsed)) return false;
    witness=parsed as Record<string,unknown>;
  } catch {
    return false;
  }
  const sessionRunKey=attempt["session_run_key"]??attempt["sessionRunKey"];
  if (witness["source"]!=="work_item_run" || typeof sessionRunKey!=="string"
    || witness["runKey"]!==sessionRunKey) return false;
  const stored=verificationTaskVerdictSchema.safeParse(witness["completionVerdict"]);
  if (!stored.success || stored.data.result!=="passed") return false;
  const report=typeof witness["finalReport"]==="string" ? witness["finalReport"]:null;
  return parseVerificationTaskVerdict(report,"completed").result==="passed";
}

function inconclusiveVerdict():VerificationTaskVerdict {
  return {result:"inconclusive",confidence:0};
}

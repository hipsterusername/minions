import { MAX_VERIFICATION_SUMMARY_CHARS } from "./evidence.ts";

type JsonRow = Record<string, unknown>;

const value = (row:JsonRow,snake:string,camel:string):unknown => row[snake] ?? row[camel];

export function projectVerificationSummary(
  verification:JsonRow,
  artifacts:JsonRow[],
):string|null {
  if (hasRestrictedArtifactContent(artifacts)) {
    return null;
  }
  const raw=value(verification,"record_json","recordJson");
  let record:Record<string,unknown>;
  try {
    record=typeof raw==="string" ? JSON.parse(raw) as Record<string,unknown>
      : raw && typeof raw==="object" ? raw as Record<string,unknown>:{};
  } catch {
    return null;
  }
  if (typeof record["summary"]!=="string") return null;
  return redactTaskGraphText(
    record["summary"].trim().slice(0,MAX_VERIFICATION_SUMMARY_CHARS),
  ) || null;
}

export function redactTaskGraphText(summary:string):string {
  let redacted=summary;
  for (let pass=0;pass<2;pass+=1) redacted=redacted.replace(
      /((?:["'][A-Za-z][A-Za-z0-9_-]*["'])|(?:\b[A-Za-z][A-Za-z0-9_-]*))(\s*[:=]\s*)(?:(?:Bearer|Basic|Digest|Negotiate|AWS4-HMAC-SHA256)\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi,
      (match,key:string,separator:string)=>isCredentialKey(key)
        ? `${key}${separator}[REDACTED]`:match,
    );
  return redacted
    .replace(/\b(Bearer|Basic|Digest|Negotiate|AWS4-HMAC-SHA256)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1 [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]");
}

export function hasRestrictedArtifactContent(artifacts:JsonRow[]):boolean {
  return artifacts.some(artifact=>["sensitive","secret"].includes(artifactClassification(artifact)));
}

export function redactTaskGraphPayload(payload:unknown):unknown {
  if (typeof payload==="string") return redactTaskGraphText(payload);
  if (Array.isArray(payload)) return payload.map(redactTaskGraphPayload);
  if (!payload || typeof payload!=="object") return payload;
  return Object.fromEntries(Object.entries(payload as Record<string,unknown>).map(([key,item])=>[
    key,isCredentialKey(key)?"[REDACTED]":redactTaskGraphPayload(item),
  ]));
}

function isCredentialKey(rawKey:string):boolean {
  const key=rawKey.replace(/["'_-]/g,"").toLowerCase();
  return ["accesstoken","auth","authorization","apikey","clientsecret","cookie","password",
    "passwd","secret","secretaccesskey","token"].some(suffix=>key.endsWith(suffix));
}

function artifactClassification(artifact:JsonRow):string {
  const raw=value(artifact,"metadata_json","metadataJson");
  try {
    const metadata=typeof raw==="string" ? JSON.parse(raw) as Record<string,unknown>
      : raw && typeof raw==="object" ? raw as Record<string,unknown>:{};
    return typeof metadata["classification"]==="string" ? metadata["classification"]:"internal";
  } catch {
    return "sensitive";
  }
}

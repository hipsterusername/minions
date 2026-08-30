import Ajv,{type AnySchema,type ErrorObject} from "ajv";
import {TaskGraphValidationError} from "./errors.ts";

const validator=new Ajv({strict:false,allErrors:true});
const MAX_VALUE_CHARS=240;

export function artifactContractExample(schema:unknown):unknown {
  return exampleFor(schema,new Set());
}

export function validateArtifactContract(value:unknown,schema:unknown):void {
  let validate;
  try { validate=validator.compile(schema as AnySchema); }
  catch (error) {
    throw new TaskGraphValidationError(
      `declared artifact output schema is invalid or unsupported: ${errorMessage(error)}`,
    );
  }
  if (validate(value)) return;
  throw new TaskGraphValidationError(formatValidationErrors(validate.errors??[],value));
}

function exampleFor(schema:unknown,seen:Set<unknown>):unknown {
  if (!schema || typeof schema!=="object" || seen.has(schema)) return {};
  seen.add(schema);
  const value=schema as Record<string,unknown>;
  if (value["example"]!==undefined) return value["example"];
  if (Array.isArray(value["examples"]) && value["examples"].length) return value["examples"][0];
  if (value["default"]!==undefined) return value["default"];
  if (value["const"]!==undefined) return value["const"];
  if (Array.isArray(value["enum"]) && value["enum"].length) return value["enum"][0];
  for (const branch of ["oneOf","anyOf","allOf"] as const) {
    const alternatives=value[branch];
    if (Array.isArray(alternatives) && alternatives.length) return exampleFor(alternatives[0],seen);
  }
  const type=Array.isArray(value["type"])?value["type"][0]:value["type"];
  if (type==="object" || value["properties"]) {
    const properties=value["properties"]&&typeof value["properties"]==="object"
      ? value["properties"] as Record<string,unknown>:{};
    const required=new Set(Array.isArray(value["required"])
      ? value["required"].filter((item):item is string=>typeof item==="string")
      :Object.keys(properties));
    return Object.fromEntries([...required]
      .map(name=>[name,exampleFor(properties[name]??{},seen)]));
  }
  if (type==="array") return [exampleFor(value["items"],seen)];
  if (type==="string") return typeof value["format"]==="string"?`<${value["format"]}>`:"string";
  if (type==="integer" || type==="number") return typeof value["minimum"]==="number"?value["minimum"]:0;
  if (type==="boolean") return true;
  if (type==="null") return null;
  return {};
}

function formatValidationErrors(errors:ErrorObject[],root:unknown):string {
  const details=errors.slice(0,8).map(error=>{
    const path=jsonPath(error.instancePath);
    const received=valueAt(root,error.instancePath);
    if (error.keyword==="required") {
      const missing=String((error.params as {missingProperty?:unknown}).missingProperty??"unknown");
      return `${path}: missing required property "${missing}"; expected property to be present; received ${preview(received)}`;
    }
    return `${path}: expected ${expected(error)}; received ${preview(received)}`;
  });
  const suffix=errors.length>details.length?`; plus ${errors.length-details.length} more error(s)`:"";
  return `artifact content does not satisfy declared output schema: ${details.join("; ")}${suffix}. Repair inlineJson and restage this output; the rejected draft did not consume the output slot.`;
}

function expected(error:ErrorObject):string {
  const params=error.params as Record<string,unknown>;
  if (error.keyword==="type") return `type ${String(params["type"]??"declared")}`;
  if (error.keyword==="enum") return `one of ${preview(params["allowedValues"])}`;
  if (error.keyword==="additionalProperties") return `no additional property "${String(params["additionalProperty"]??"")}"`;
  if (error.keyword==="minItems") return `at least ${String(params["limit"])} item(s)`;
  if (error.keyword==="minLength") return `a string with at least ${String(params["limit"])} character(s)`;
  return `${error.keyword} ${preview(params)}`;
}

function jsonPath(instancePath:string):string {
  if (!instancePath) return "$";
  return `$${instancePath.split("/").slice(1).map(segment=>{
    const decoded=segment.replaceAll("~1","/").replaceAll("~0","~");
    return /^\d+$/.test(decoded)?`[${decoded}]`:`.${decoded}`;
  }).join("")}`;
}

function valueAt(root:unknown,instancePath:string):unknown {
  let current=root;
  for (const segment of instancePath.split("/").slice(1)) {
    const key=segment.replaceAll("~1","/").replaceAll("~0","~");
    if (!current || typeof current!=="object") return current;
    current=(current as Record<string,unknown>)[key];
  }
  return current;
}

function preview(value:unknown):string {
  let rendered:string;
  try { rendered=JSON.stringify(value); }
  catch { rendered=String(value); }
  if (rendered===undefined) rendered="undefined";
  return rendered.length>MAX_VALUE_CHARS?`${rendered.slice(0,MAX_VALUE_CHARS-1)}…`:rendered;
}

function errorMessage(error:unknown):string {
  return error instanceof Error?error.message:String(error);
}

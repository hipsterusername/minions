#!/usr/bin/env node
import { spawnSync } from "child_process";
import { existsSync } from "node:fs";
import { loadSystemModel } from "../server/system-model/load.ts";
import { validateLoadedSystemModel } from "../server/system-model/validate.ts";

const cwd = process.cwd();
const strict = process.argv.includes("--strict");
const requireManifest = process.argv.includes("--require-manifest");
const { model, errors } = loadSystemModel(cwd);

const manifestMissing = !model && errors.length === 1
  && errors[0]?.file === ".systemmodel/manifest.yaml"
  && errors[0]?.message === "manifest.yaml not found";
if (manifestMissing && !requireManifest) {
  console.log("System model not configured; validation skipped");
  process.exit(0);
}

if (!model || errors.length > 0) {
  const fatalErrors = errors.filter((error) => error.severity !== "warning");
  const warnings = errors.filter((error) => error.severity === "warning");
  if (fatalErrors.length > 0 || !model) {
    console.error(`System model validation failed for ${cwd}`);
  }
  for (const error of fatalErrors) {
    const where = error.path ? `${error.file}:${error.path}` : error.file;
    console.error(`- ${where}: ${error.message}`);
  }
  printWarnings(warnings);
  process.exit(fatalErrors.length > 0 || !model || (strict && warnings.length > 0) ? 1 : 0);
}

const warnings = validateLoadedSystemModel(model, trackedFiles()).filter((error) => error.severity === "warning");
printWarnings(warnings);
if (strict && warnings.length > 0) process.exit(1);
console.log(`System model valid: ${model.objectsById.size} objects`);

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, encoding: "utf8" });
  if (result.status !== 0 && !result.stdout) {
    throw result.error ?? new Error(result.stderr || "git ls-files failed");
  }
  return [...new Set(result.stdout.split("\0").filter((file) => file && existsSync(file)))];
}

function printWarnings(warnings) {
  if (warnings.length === 0) return;
  console.warn("System model validation warnings:");
  for (const warning of warnings) {
    const where = warning.path ? `${warning.file}:${warning.path}` : warning.file;
    console.warn(`- ${where}: ${warning.message}`);
  }
}

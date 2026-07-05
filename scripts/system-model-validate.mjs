#!/usr/bin/env node
import { loadSystemModel } from "../server/system-model/load.ts";

const cwd = process.cwd();
const { model, errors } = loadSystemModel(cwd);

if (!model || errors.length > 0) {
  console.error(`System model validation failed for ${cwd}`);
  for (const error of errors) {
    const where = error.path ? `${error.file}:${error.path}` : error.file;
    console.error(`- ${where}: ${error.message}`);
  }
  process.exit(1);
}

console.log(`System model valid: ${model.objectsById.size} objects`);

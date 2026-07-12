#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const summaryPath = path.resolve("coverage/coverage-summary.json");
if (!fs.existsSync(summaryPath)) {
  console.error(`Coverage summary not found: ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const metrics = ["lines", "statements", "branches", "functions"];

function aggregate(fragment) {
  const totals = Object.fromEntries(metrics.map((metric) => [metric, { covered: 0, total: 0 }]));
  for (const [file, record] of Object.entries(summary)) {
    if (file === "total" || !file.includes(fragment)) continue;
    for (const metric of metrics) {
      totals[metric].covered += record[metric].covered;
      totals[metric].total += record[metric].total;
    }
  }
  return Object.fromEntries(
    metrics.map((metric) => {
      const value = totals[metric];
      return [metric, value.total === 0 ? 100 : (value.covered / value.total) * 100];
    }),
  );
}

function row(label, record) {
  return `| ${label} | ${record.lines.toFixed(2)}% | ${record.branches.toFixed(2)}% | ${record.functions.toFixed(2)}% |`;
}

const total = Object.fromEntries(metrics.map((metric) => [metric, summary.total[metric].pct]));
const output = [
  "## Coverage diagnostic",
  "",
  "Coverage is reported as a trend diagnostic, not a global merge floor.",
  "",
  "| Surface | Lines | Branches | Functions |",
  "|---|---:|---:|---:|",
  row("Overall", total),
  row("Server", aggregate(`${path.sep}server${path.sep}`)),
  row("Frontend", aggregate(`${path.sep}src${path.sep}`)),
  row("Shared", aggregate(`${path.sep}shared${path.sep}`)),
  "",
  "High-risk modules should be reviewed behavior-by-behavior when their trend drops; the aggregate is not a substitute for contract coverage.",
].join("\n");

process.stdout.write(`${output}\n`);

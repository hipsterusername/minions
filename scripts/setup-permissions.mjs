#!/usr/bin/env node

/**
 * Auto-configure Claude Code permissions for all Minions MCP tools.
 *
 * Run: pnpm configure   (or:  node scripts/setup-permissions.mjs)
 *
 * Writes project-level permissions to .claude/settings.json so the
 * Leader/Minion orchestration flow works without interactive prompts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// All MCP tools exposed by the three in-process MCP servers.
const MCP_TOOLS = [
  // task-manager (Leader orchestration)
  "mcp__task-manager__plan_task",
  "mcp__task-manager__assign_task",
  "mcp__task-manager__complete_task",
  "mcp__task-manager__get_task_status",
  "mcp__task-manager__set_task_name",
  "mcp__task-manager__wait_and_continue",
  "mcp__task-manager__request_approval",

  // render-dashboard (Leader → UI components)
  "mcp__render-dashboard__render_set",
  "mcp__render-dashboard__render_patch",
  "mcp__render-dashboard__render_append",
  "mcp__render-dashboard__render_remove",

  // minion-status (Minion → Leader status reports)
  "mcp__minion-status__report_step",
  "mcp__minion-status__report_done",
  "mcp__minion-status__report_fail",
];

const settingsDir = join(process.cwd(), ".claude");
const settingsPath = join(settingsDir, "settings.json");

console.log("\nMinions — MCP permission setup\n");

// Load existing settings or start fresh
let settings = {};
try {
  const raw = readFileSync(settingsPath, "utf8");
  settings = JSON.parse(raw);
  console.log("  Found existing .claude/settings.json");
} catch {
  console.log("  Creating .claude/settings.json");
}

// Merge permissions — preserve any existing allow entries
const existing = settings.permissions?.allow ?? [];
const existingSet = new Set(existing);
const toAdd = MCP_TOOLS.filter((t) => !existingSet.has(t));

if (toAdd.length === 0) {
  console.log("  \x1b[32m✓\x1b[0m All MCP tool permissions already configured.\n");
  process.exit(0);
}

// Build merged allow list: existing entries + new MCP tools
const merged = [...existing, ...toAdd];
settings.permissions = { ...settings.permissions, allow: merged };

// Write back
mkdirSync(settingsDir, { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

console.log(`  \x1b[32m✓\x1b[0m Added ${toAdd.length} MCP tool permission(s):\n`);
for (const tool of toAdd) {
  console.log(`      + ${tool}`);
}
console.log(`\n  Written to: .claude/settings.json`);
console.log("  Orchestration will now run without permission prompts.\n");

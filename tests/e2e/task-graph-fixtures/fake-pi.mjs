#!/usr/bin/env node

if (process.argv.includes("--list-models")) {
  process.stdout.write("fixture\tmodel\tDeterministic Fixture Model\n");
  process.exit(0);
}

// The primary authority must remain live while its graph schedules children.
// Its eventual SIGTERM comes from the real WorkItem review/stop path.
process.stdout.write(`${JSON.stringify({ type: "session", id: `fixture-${process.pid}` })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
setInterval(() => {}, 60_000);

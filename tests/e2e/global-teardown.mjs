import fs from "node:fs";

export default function globalTeardown() {
  const home = process.env.MINIONS_E2E_HOME;
  if (home) fs.rmSync(home, { recursive: true, force: true });
}

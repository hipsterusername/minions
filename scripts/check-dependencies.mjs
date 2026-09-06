import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));

export function checkDependencies(packages = ["tsx", "better-sqlite3"]) {
  const missing = packages.filter((name) => {
    try {
      require.resolve(name);
      return false;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
      return true;
    }
  });
  if (missing.length > 0) {
    console.error(`Local dependencies are missing (${missing.join(", ")}). Run \`pnpm install\` first.`);
    process.exit(1);
  }
}

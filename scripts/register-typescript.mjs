// This preload uses only Node built-ins until dependencies have been checked.
import { checkDependencies } from "./check-dependencies.mjs";

checkDependencies();
await import("tsx");

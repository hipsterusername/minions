import { readFileSync } from 'node:fs';
// Replace this CSV echo with the monthly report described in README.md.
process.stdout.write(readFileSync(0, 'utf8'));

// Trusted environment-only probe: never load candidate source or interpret its output.
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE preflight (id INTEGER)');
db.close();
const server = createServer();
await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
await browser.close();

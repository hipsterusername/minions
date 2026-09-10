// Executed in the submission cwd. Only operations and observations live here;
// no expected result, criterion verdict or participant import enters this process.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const input = JSON.parse(readFileSync(0,'utf8'));
const temporary = await mkdtemp(join(tmpdir(),'archive-probe-'));
const database = join(temporary,'projects.sqlite');
const db = new DatabaseSync(database);
db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, description TEXT NOT NULL)');
for (const row of input.rows) db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(row.id,row.name,row.owner,row.description);
db.close();
let child, closed, base, browser;
async function start() {
  child = spawn(process.execPath,['src/server.mjs'], {env:{...process.env,DB_PATH:database,PORT:'0'},stdio:['ignore','pipe','pipe']});
  closed = new Promise(resolve => child.once('close',resolve));
  let errors = ''; child.stderr.on('data',chunk => { errors += chunk; });
  const lines = createInterface({input:child.stdout});
  base = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('server readiness timeout: '+errors)),5000);
    child.once('error',error => {clearTimeout(timer);reject(error);});
    child.once('exit',() => {clearTimeout(timer);reject(new Error('server exited: '+errors));});
    lines.on('line',line => {try { const {port} = JSON.parse(line); if (Number.isInteger(port) && port > 0) {clearTimeout(timer);resolve('http://127.0.0.1:'+port);} } catch {} });
  });
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (closed) await closed; }
async function call(path,method='GET',body) {
  const response = await fetch(base+path,{method, ...(body === undefined ? {} : {body:JSON.stringify(body),headers:{'content-type':'application/json'}}),signal:AbortSignal.timeout(3000)});
  return {status:response.status,body:await response.json()};
}
const output = {};
const target = '/api/projects/'+encodeURIComponent(input.rows[0].id);
try {
  await start();
  output.initial = await call('/api/projects');
  output.explicit = await call('/api/projects?archived=false');
  output.emptyArchived = await call('/api/projects?archived=true');
  output.editActive = await call(target,'PATCH',input.patch);
  output.invalid = [];
  for (const value of [null,[],{id:'new'},{name:4}]) output.invalid.push(await call(target,'PATCH',value));
  output.invalidFilter = await call('/api/projects?archived=all');
  output.missing = [];
  for (const [suffix,method] of [['','GET'],['','PATCH'],['/archive','POST'],['/restore','POST']]) output.missing.push(await call('/api/projects/missing'+suffix,method,method === 'PATCH' ? {} : undefined));
  output.archive = await call(target+'/archive','POST');
  output.repeatArchive = await call(target+'/archive','POST');
  output.active = await call('/api/projects');
  output.archived = await call('/api/projects?archived=true');
  output.detail = await call(target);
  output.editArchived = await call(target,'PATCH',{name:'forbidden'});
  output.emptyEditArchived = await call(target,'PATCH',{});
  await stop(); await start();
  output.restart = await call(target);
  output.restartActive = await call('/api/projects');
  output.restartArchived = await call('/api/projects?archived=true');
  output.restore = await call(target+'/restore','POST');
  output.repeatRestore = await call(target+'/restore','POST');
  output.restoredActive = await call('/api/projects');
  output.editRestored = await call(target,'PATCH',{description:input.finalDescription});
  await stop();
  const inspect = new DatabaseSync(database);
  output.disk = inspect.prepare('SELECT * FROM projects ORDER BY id COLLATE BINARY').all();
  output.columns = inspect.prepare('PRAGMA table_info(projects)').all().map(row => row.name);
  inspect.close();
  await start(); output.final = await call(target);
  try {
    const {chromium} = await import('playwright');
    browser = await chromium.launch({headless:true,args:['--no-sandbox']});
    const page = await browser.newPage(); page.setDefaultTimeout(3000);
    await page.goto(base);
    const row = page.locator('[data-project-id]').filter({has:page.getByRole('button',{name:'Archive',exact:true})});
    const targetRow = page.locator('[data-project-id]').filter({hasText:input.patch.name});
    await targetRow.getByRole('button',{name:'Archive',exact:true}).click();
    await targetRow.waitFor({state:'detached'});
    output.ui = {afterArchive:await call(target), activeCount:await row.count()};
    await page.getByRole('combobox',{name:'Project filter'}).selectOption('true');
    await targetRow.getByRole('button',{name:'Restore',exact:true}).waitFor();
    output.ui.archivedText = await targetRow.locator('span').textContent();
    output.ui.injectedElements = await targetRow.locator('img,script').count();
    await targetRow.getByRole('button',{name:'Restore',exact:true}).click();
    await targetRow.waitFor({state:'detached'});
    await page.getByRole('combobox',{name:'Project filter'}).selectOption('false');
    await targetRow.getByRole('button',{name:'Archive',exact:true}).waitFor();
    await page.reload();
    await page.locator('[data-project-id]').filter({hasText:input.patch.name}).getByRole('button',{name:'Archive',exact:true}).waitFor();
    output.ui.afterRestore = await call(target);
  } catch(error) { output.uiError = error.message; }
} catch(error) {output.error = error.message;}
finally {if(browser) await browser.close(); await stop(); await rm(temporary,{recursive:true,force:true});}
process.stdout.write(JSON.stringify(output));

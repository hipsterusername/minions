import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

const db = new DatabaseSync(process.env.DB_PATH || 'projects.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, description TEXT NOT NULL)');
// TODO: migrate archive state without losing existing projects.
const detail = id => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
const server = createServer(async (request, response) => {
  const send = (status, body) => { response.writeHead(status, {'content-type':'application/json'}); response.end(JSON.stringify(body)); };
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app.js')) {
      response.writeHead(200, {'content-type':url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'});
      response.end(await readFile(new URL(url.pathname === '/' ? './index.html' : './app.js', import.meta.url))); return;
    }
    if (url.pathname === '/api/projects' && request.method === 'GET') {
      const filter = url.searchParams.get('archived');
      if (filter !== null && filter !== 'true' && filter !== 'false') return send(400, {error:'INVALID_FILTER'});
      return send(200, db.prepare('SELECT * FROM projects ORDER BY id COLLATE BINARY').all());
    }
    const match = /^\/api\/projects\/([^/]+)(?:\/(archive|restore))?$/.exec(url.pathname);
    if (!match) return send(404, {error:'NOT_FOUND'});
    const id = decodeURIComponent(match[1]);
    const row = detail(id);
    if (!row) return send(404, {error:'NOT_FOUND'});
    if (!match[2] && request.method === 'GET') return send(200, row);
    // TODO: implement archive and restore endpoints.
    if (request.method === 'PATCH' && !match[2]) {
      let raw = ''; for await (const chunk of request) raw += chunk;
      let patch; try { patch = JSON.parse(raw); } catch { return send(400, {error:'INVALID_PATCH'}); }
      if (!patch || Array.isArray(patch) || typeof patch !== 'object' || Object.entries(patch).some(([key,value]) => !['name','owner','description'].includes(key) || typeof value !== 'string')) return send(400, {error:'INVALID_PATCH'});
      db.prepare('UPDATE projects SET name = ?, owner = ?, description = ? WHERE id = ?').run(patch.name ?? row.name, patch.owner ?? row.owner, patch.description ?? row.description, id);
      return send(200, detail(id));
    }
    return send(405, {error:'METHOD_NOT_ALLOWED'});
  } catch { send(500, {error:'INTERNAL'}); }
});
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log(JSON.stringify({port:server.address().port})));
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));

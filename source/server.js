#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const mimeTypes = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.pdf':'application/pdf'};

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const STORAGE = process.env.FILE_BRIDGE_STORAGE || path.join(ROOT, 'received');
const DATA_DIR = path.join(ROOT, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
const STATE_FILE = path.join(DATA_DIR, 'items.json');
const ARCHIVE_DIR = path.join(ROOT, 'archive');
const ARCHIVE_FILES = path.join(ARCHIVE_DIR, 'files');
const ARCHIVE_STATE_FILE = path.join(ARCHIVE_DIR, 'items.json');
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const KEEP_FOR_MS = 24 * 60 * 60 * 1000;
let recent = [];
let archived = [];
fs.mkdirSync(STORAGE, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ARCHIVE_FILES, { recursive: true });
let TOKEN = process.env.FILE_BRIDGE_TOKEN;
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, TOKEN, 'utf8');
}

function loadJson(file) { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; } }
function saveJson(file, value) { const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8'); fs.renameSync(temp, file); }
function pruneAndSave() {
  const cutoff = Date.now() - KEEP_FOR_MS;
  const expired = recent.filter(item => item.createdAt < cutoff);
  for (const item of expired) {
    if (item.kind !== 'text' && item.download) {
      const name = safeName(decodeURIComponent(item.download.slice('/api/download/'.length)));
      const target = path.join(STORAGE, name);
      if (target.startsWith(STORAGE + path.sep)) fs.rmSync(target, { force: true });
    }
  }
  recent = recent.filter(item => item.createdAt >= cutoff);
  saveJson(STATE_FILE, recent);
}
recent = loadJson(STATE_FILE); archived = loadJson(ARCHIVE_STATE_FILE); pruneAndSave();
// Remove orphaned unarchived files older than the one-day retention window.
const activeFiles = new Set(recent.filter(item => item.download).map(item => safeName(decodeURIComponent(item.download.slice('/api/download/'.length)))));
for (const file of fs.readdirSync(STORAGE)) {
  const target = path.join(STORAGE, file);
  if (!activeFiles.has(file) && fs.statSync(target).isFile() && fs.statSync(target).mtimeMs < Date.now() - KEEP_FOR_MS) fs.rmSync(target, { force: true });
}

function authorized(req, url) {
  return req.headers['x-file-bridge-token'] === TOKEN || url.searchParams.get('token') === TOKEN;
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function safeName(name) {
  const base = path.basename(String(name || 'upload.bin')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base || 'upload.bin';
}
function uniquePath(name) {
  const ext = path.extname(name); const stem = path.basename(name, ext);
  let candidate = path.join(STORAGE, name); let number = 1;
  while (fs.existsSync(candidate)) candidate = path.join(STORAGE, `${stem} (${number++})${ext}`);
  return candidate;
}
function record(item) { recent.unshift(item); pruneAndSave(); }
function byId(id) { return recent.find(item => item.id === id); }
function serveStatic(res, file, type) {
  fs.readFile(file, (err, body) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    if (!authorized(req, url)) return json(res, 401, { error: '访问令牌不正确。请使用完整链接。' });
    res.setHeader('set-cookie', `fileBridgeToken=${encodeURIComponent(TOKEN)}; Path=/; SameSite=Lax; Max-Age=604800`);
    return serveStatic(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/app.js') return serveStatic(res, path.join(PUBLIC, 'app.js'), 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/api/items') {
    if (!authorized(req, url)) return json(res, 401, { error: 'Unauthorized' });
    return json(res, 200, { items: recent });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/archive/')) {
    if (!authorized(req, url)) return json(res, 401, { error: 'Unauthorized' });
    const id = decodeURIComponent(url.pathname.slice('/api/archive/'.length));
    const item = byId(id);
    if (!item) return json(res, 404, { error: 'Item not found or expired.' });
    const archivedItem = { ...item, archivedAt: Date.now() };
    if (item.kind !== 'text') {
      const sourceName = path.basename(decodeURIComponent(item.download.slice('/api/download/'.length)));
      const source = path.join(STORAGE, sourceName);
      const archivedName = `${item.id}-${sourceName}`;
      const destination = path.join(ARCHIVE_FILES, archivedName);
      if (!fs.existsSync(source)) return json(res, 404, { error: 'Source file is missing.' });
      if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
      archivedItem.download = `/api/archive-download/${encodeURIComponent(archivedName)}`;
    }
    archived = archived.filter(row => row.id !== id); archived.unshift(archivedItem); saveJson(ARCHIVE_STATE_FILE, archived);
    return json(res, 201, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/text') {
    if (!authorized(req, url)) return json(res, 401, { error: 'Unauthorized' });
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size <= MAX_TEXT_BYTES) chunks.push(chunk); else req.destroy(); });
    req.on('end', () => { if (size > MAX_TEXT_BYTES) return json(res, 413, { error: '文本超过 1 MB。' }); const text = Buffer.concat(chunks).toString('utf8').trim(); if (!text) return json(res, 400, { error: '内容为空。' }); record({ id: crypto.randomUUID(), kind: 'text', text, createdAt: Date.now() }); json(res, 201, { ok: true }); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/file') {
    if (!authorized(req, url)) return json(res, 401, { error: 'Unauthorized' });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_FILE_BYTES) return json(res, 413, { error: '文件不能超过 1 GB。' });
    const fileName = safeName(decodeURIComponent(req.headers['x-file-name'] || 'upload.bin'));
    const target = uniquePath(fileName); const output = fs.createWriteStream(target, { flags: 'wx' }); let size = 0; let done = false;
    const fail = (status, message) => { if (done) return; done = true; output.destroy(); fs.rm(target, { force: true }, () => json(res, status, { error: message })); };
    req.on('data', chunk => { size += chunk.length; if (size > MAX_FILE_BYTES) { req.destroy(); fail(413, '文件不能超过 1 GB。'); } });
    req.on('aborted', () => fail(400, '上传被取消。'));
    output.on('error', () => fail(500, '无法写入接收目录。'));
    output.on('finish', () => { if (done) return; done = true; const item = { id: crypto.randomUUID(), kind: (req.headers['content-type'] || '').startsWith('image/') ? 'image' : 'file', name: fileName, size, mime: req.headers['content-type'] || 'application/octet-stream', createdAt: Date.now(), download: `/api/download/${encodeURIComponent(path.basename(target))}` }; record(item); json(res, 201, { ok: true, item }); });
    req.pipe(output); return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/download/')) {
    if (!authorized(req, url)) return json(res, 401, { error: 'Unauthorized' });
    const name = safeName(decodeURIComponent(url.pathname.slice('/api/download/'.length))); const target = path.join(STORAGE, name);
    if (!target.startsWith(STORAGE + path.sep) || !fs.existsSync(target)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': mimeTypes[path.extname(name).toLowerCase()] || 'application/octet-stream', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` }); fs.createReadStream(target).pipe(res); return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/archive-download/')) {
    if (!authorized(req, url)) return json(res, 401, { error: 'Unauthorized' });
    const name = safeName(decodeURIComponent(url.pathname.slice('/api/archive-download/'.length)));
    const target = path.join(ARCHIVE_FILES, name);
    if (!target.startsWith(ARCHIVE_FILES + path.sep) || !fs.existsSync(target)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }); fs.createReadStream(target).pipe(res); return;
  }
  json(res, 404, { error: 'Not found' });
});
server.listen(PORT, HOST, () => console.log(`File Bridge running: http://localhost:${PORT}/?token=${TOKEN}`));

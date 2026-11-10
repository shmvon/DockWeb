import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

import { makeIconPng } from './icon-png.js';

const ROOT = import.meta.dirname;
const DATA_DIR = process.env.DOCKWEB_DATA || ROOT; // DockWeb.app sets ~/Library/Application Support/DockWeb
const PORT = Number(process.env.PORT) || 8511;
const HOST = process.env.HOST || '0.0.0.0';
const ICON_PX = 256; // crisp at 3x on ~80px tiles
const ICONS_DIR = path.join(DATA_DIR, '.cache', 'icons');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const HOME = os.homedir();
const DOCK_PLIST = path.join(HOME, 'Library/Preferences/com.apple.dock.plist');
const FINDER = '/System/Library/CoreServices/Finder.app';
fs.mkdirSync(ICONS_DIR, { recursive: true });

// ---------------------------------------------------------------- helpers

const ENV = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };

/** Run a program with an argument array (never through a shell). */
function run(cmd, args = [], { input, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, env: ENV, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(stdout.trim());
    });
    child.stdin.on('error', () => {}); // child may exit before reading stdin (EPIPE)
    if (input != null) child.stdin.end(input);
  });
}

const osa = (...lines) => run('osascript', lines.flatMap(l => ['-e', l]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- config / auth

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  let dirty = false;
  if (!cfg.pin) { cfg.pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); dirty = true; }
  if (!Array.isArray(cfg.sessions)) { cfg.sessions = []; dirty = true; }
  if (dirty) saveConfig(cfg);
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ pin: cfg.filePin ?? cfg.pin, sessions: cfg.sessions }, null, 2), { mode: 0o600 });
}
const config = loadConfig();
if (process.env.DOCKWEB_PIN) { config.filePin = config.pin; config.pin = process.env.DOCKWEB_PIN; } // env PIN is never written to disk

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const failures = new Map(); // ip -> { count, lockedUntil }
function isLocked(ip) { return (failures.get(ip)?.lockedUntil || 0) > Date.now(); }
function noteFailure(ip) {
  const f = failures.get(ip) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= 5) { f.lockedUntil = Date.now() + 60_000; f.count = 0; }
  failures.set(ip, f);
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
function isAuthed(req) {
  const token = getCookie(req, 'dw');
  return !!token && config.sessions.some(s => safeEqual(s, token));
}
function issueSession() {
  const token = crypto.randomBytes(32).toString('hex');
  config.sessions = [...config.sessions.slice(-19), token];
  saveConfig(config);
  return token;
}

// ---------------------------------------------------------------- dock

const appId = appPath => crypto.createHash('sha1').update(appPath).digest('hex').slice(0, 10);
const jxa = (script, ...args) => run('osascript', ['-l', 'JavaScript', path.join(ROOT, 'scripts', script), ...args]);

let pinnedCache = { mtime: 0, apps: [] };

/** Finder + the Dock's pinned apps, in Dock order. */
async function getPinnedApps() {
  try {
    const { mtimeMs } = await fsp.stat(DOCK_PLIST);
    if (mtimeMs === pinnedCache.mtime) return pinnedCache.apps;
    const apps = [{ id: appId(FINDER), label: 'Finder', path: FINDER, bundleId: 'com.apple.finder' }];
    for (const tile of JSON.parse(await jxa('dock.js', DOCK_PLIST))) {
      const appPath = decodeURIComponent(tile.url.replace(/^file:\/\//, '').replace(/\/$/, ''));
      if (!appPath || appPath === FINDER || !fs.existsSync(appPath)) continue;
      apps.push({ id: appId(appPath), label: tile.label || path.basename(appPath, '.app'), path: appPath, bundleId: tile.bundleId || '' });
    }
    pinnedCache = { mtime: mtimeMs, apps };
  } catch (err) {
    console.error('dock read failed:', err.message);
  }
  return pinnedCache.apps;
}

let runningCache = { at: 0, apps: [] };
/** Regular (Dock-visible) running apps, via NSWorkspace: no Automation permission needed. */
async function getRunningApps() {
  if (Date.now() - runningCache.at < 1500) return runningCache.apps;
  try {
    runningCache = { at: Date.now(), apps: JSON.parse(await jxa('running.js')) };
  } catch (err) {
    console.error('running apps failed:', err.message);
  }
  return runningCache.apps;
}

/** What the real Dock shows: Finder, pinned apps, then running apps that aren't pinned. */
async function getDockApps() {
  const [pinned, running] = await Promise.all([getPinnedApps(), getRunningApps()]);
  const runningPaths = new Set(running.map(r => r.path));
  const runningIds = new Set(running.map(r => r.bundleId).filter(Boolean));
  const isRunning = a => runningPaths.has(a.path) || (!!a.bundleId && runningIds.has(a.bundleId));
  const apps = pinned.map(a => ({ ...a, isRunning: isRunning(a), pinned: true }));
  const seen = new Set(pinned.flatMap(a => [a.path, a.bundleId]).filter(Boolean));
  for (const r of running) {
    if (seen.has(r.path) || (r.bundleId && seen.has(r.bundleId))) continue;
    seen.add(r.path); if (r.bundleId) seen.add(r.bundleId);
    apps.push({ id: appId(r.path), label: r.name || path.basename(r.path, '.app'), path: r.path, bundleId: r.bundleId, isRunning: true, pinned: false });
  }
  return apps;
}

const iconJobs = new Map();
async function ensureIcon(app) {
  const png = path.join(ICONS_DIR, `${app.id}-${ICON_PX}.png`);
  if (fs.existsSync(png)) return true;
  if (!iconJobs.has(app.id)) {
    iconJobs.set(app.id, (async () => {
      try {
        await jxa('icon.js', app.path, png, String(ICON_PX));
        return true;
      } catch (err) {
        console.error(`icon for ${app.label} failed:`, err.message);
        try { await fsp.unlink(png); } catch {}
        return false;
      } finally { iconJobs.delete(app.id); }
    })());
  }
  return iconJobs.get(app.id);
}

async function dockPayload() {
  const apps = await getDockApps();
  const icons = await Promise.all(apps.map(ensureIcon));
  return apps.map((a, i) => ({
    id: a.id,
    label: a.label,
    iconUrl: icons[i] ? `/icons/${a.id}.png` : null,
    isRunning: a.isRunning,
    pinned: a.pinned
  }));
}

// Key codes: 125 = down arrow, 3 = F.
const KEY = { expose: ['125', 'ctrl'], fullscreen: ['3', 'cmd,ctrl'] };

async function postKeys(...args) {
  // Key events are posted by the DockWeb.app binary (it holds the Accessibility grant).
  const helper = process.env.DOCKWEB_HELPER;
  if (!helper) throw httpError(501, 'Keyboard and media control need DockWeb.app (run ./build.sh)');
  if (await run(helper, ['--keys', ...args]) === 'noperm') throw httpError(403, PERMISSION_HINT);
}

async function dockAction({ action, id }) {
  const app = (await getDockApps()).find(a => a.id === id);
  if (!app) throw httpError(404, 'Unknown app');
  switch (action) {
    case 'select':
      await run('open', [app.path]);
      break;
    case 'expose':
    case 'fullscreen':
      await run('open', [app.path]);
      await sleep(350);
      await postKeys('key', ...KEY[action]);
      break;
    case 'quit':
      if (!app.bundleId) throw httpError(400, 'App has no bundle id');
      await jxa('quit.js', app.bundleId);
      runningCache.at = 0;
      break;
    default:
      throw httpError(400, 'Unknown action');
  }
}

// ---------------------------------------------------------------- system

const PERMISSION_HINT = 'Allow DockWeb under System Settings → Privacy & Security → Accessibility';
const MEDIA_KEYS = { volup: 0, voldown: 1, mute: 7, playpause: 16, next: 17, prev: 18 };
const DESTRUCTIVE = new Set(['logout', 'restart', 'shutdown']);

async function hasBrightness() {
  try { await run('brightness', ['-l']); return true; } catch { return false; }
}

async function systemAction({ command, value, confirm }) {
  if (command in MEDIA_KEYS) return postKeys('media', String(MEDIA_KEYS[command]));
  if (DESTRUCTIVE.has(command) && confirm !== true) throw httpError(400, 'Confirmation required');
  switch (command) {
    case 'brightness': {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw httpError(400, 'Bad value');
      return run('brightness', [String(v / 100)]);
    }
    case 'displaysleep': return run('pmset', ['displaysleepnow']);
    case 'sleep': return run('pmset', ['sleepnow']);
    // These three need System Events (macOS asks once for Automation).
    case 'logout': return osa('tell application "System Events" to log out');
    case 'restart': return osa('tell application "System Events" to restart');
    case 'shutdown': return osa('tell application "System Events" to shut down');
    default: throw httpError(400, 'Unknown command');
  }
}

async function systemInfo() {
  const brightness = await hasBrightness();
  let current = null;
  if (brightness) {
    try {
      const m = (await run('brightness', ['-l'])).match(/brightness\s+([0-9.]+)/);
      if (m) current = Math.round(parseFloat(m[1]) * 100);
    } catch {}
  }
  return { brightness, brightnessValue: current };
}

// ---------------------------------------------------------------- places (folders on the Mac)

const CLOUD_DIR = path.join(HOME, 'Library/CloudStorage');

async function getPlaces() {
  const places = [
    { name: 'Desktop', path: path.join(HOME, 'Desktop'), kind: 'desktop' },
    { name: 'Documents', path: path.join(HOME, 'Documents'), kind: 'documents' },
    { name: 'Downloads', path: path.join(HOME, 'Downloads'), kind: 'downloads' },
    { name: 'iCloud Drive', path: path.join(HOME, 'Library/Mobile Documents/com~apple~CloudDocs'), kind: 'icloud' }
  ];
  let cloud = [];
  try { cloud = (await fsp.readdir(CLOUD_DIR)).sort(); } catch {}
  const google = cloud.filter(n => n.startsWith('GoogleDrive-'));
  const onedrive = cloud.filter(n => n.startsWith('OneDrive') && !n.startsWith('OneDrive-SharedLibraries'));
  for (const n of google) {
    const base = path.join(CLOUD_DIR, n);
    const myDrive = path.join(base, 'My Drive');
    const account = n.slice('GoogleDrive-'.length);
    places.push({ name: 'Google Drive', sub: google.length > 1 ? account : '', path: fs.existsSync(myDrive) ? myDrive : base, kind: 'gdrive' });
  }
  for (const n of onedrive) {
    const org = n.replace(/^OneDrive-?/, '');
    places.push({ name: 'OneDrive', sub: org, path: path.join(CLOUD_DIR, n), kind: 'onedrive' });
  }
  if (!google.length && fs.existsSync(path.join(HOME, 'Google Drive'))) places.push({ name: 'Google Drive', path: path.join(HOME, 'Google Drive'), kind: 'gdrive' });
  if (!onedrive.length && fs.existsSync(path.join(HOME, 'OneDrive'))) places.push({ name: 'OneDrive', path: path.join(HOME, 'OneDrive'), kind: 'onedrive' });
  return places.filter(p => fs.existsSync(p.path)).map(p => ({ ...p, id: appId(p.path) }));
}

async function placeAction({ id }) {
  const place = (await getPlaces()).find(p => p.id === id);
  if (!place) throw httpError(404, 'Unknown folder');
  await run('open', [place.path]);
}

// ---------------------------------------------------------------- volumes

async function getExternalVolumes() {
  let names = [];
  try { names = await fsp.readdir('/Volumes'); } catch { return []; }
  const result = await Promise.all(names.filter(n => !n.startsWith('.')).map(async name => {
    const full = `/Volumes/${name}`;
    try {
      if ((await fsp.lstat(full)).isSymbolicLink()) return null; // boot volume alias
      const xml = await run('diskutil', ['info', '-plist', full]);
      const info = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml }));
      if (info.Internal) return null;
      return { name, path: full };
    } catch { return null; }
  }));
  return result.filter(Boolean);
}

async function volumeAction({ action, name }) {
  const vol = (await getExternalVolumes()).find(v => v.name === name);
  if (!vol) throw httpError(404, 'Unknown volume');
  if (action === 'open') return run('open', [vol.path]);
  if (action === 'eject') return run('diskutil', ['eject', vol.path], { timeout: 30000 });
  throw httpError(400, 'Unknown action');
}

// ---------------------------------------------------------------- static assets

const ICON_PNG = makeIconPng(180);

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' }
};

// ---------------------------------------------------------------- http

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 10_000) { reject(httpError(413, 'Too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(httpError(400, 'Bad JSON')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    const ip = req.socket.remoteAddress;

    // Public: app shell, manifest, touch icon
    if (req.method === 'GET') {
      if (STATIC[pathname]) {
        const s = STATIC[pathname];
        return send(res, 200, await fsp.readFile(path.join(ROOT, s.file)), s.type);
      }
      if (pathname === '/icon.png') return send(res, 200, ICON_PNG, 'image/png');
    }

    // Login
    if (req.method === 'POST' && pathname === '/api/login') {
      if (isLocked(ip)) return send(res, 429, { error: 'Too many attempts, wait a minute' });
      const { pin } = await readJson(req);
      if (typeof pin === 'string' && safeEqual(pin, config.pin)) {
        failures.delete(ip);
        const cookie = `dw=${issueSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
        return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': cookie });
      }
      noteFailure(ip);
      return send(res, 401, { error: 'Wrong PIN' });
    }

    // Everything below requires a session
    if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });

    if (req.method === 'GET') {
      if (pathname === '/api/dock') return send(res, 200, await dockPayload());
      if (pathname === '/api/volumes') return send(res, 200, await getExternalVolumes());
      if (pathname === '/api/system') return send(res, 200, await systemInfo());
      if (pathname === '/api/places') return send(res, 200, (await getPlaces()).map(({ id, name, sub, kind }) => ({ id, name, sub: sub || '', kind })));
      const m = pathname.match(/^\/icons\/([a-f0-9]{10})\.png$/);
      if (m) {
        const file = path.join(ICONS_DIR, `${m[1]}-${ICON_PX}.png`);
        if (fs.existsSync(file)) return send(res, 200, await fsp.readFile(file), 'image/png', { 'Cache-Control': 'private, max-age=86400' });
      }
      return send(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST') {
      // JSON content-type forces a CORS preflight, blocking cross-site form posts.
      if (!(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'JSON only');
      const data = await readJson(req);
      if (pathname === '/api/dock/action') await dockAction(data);
      else if (pathname === '/api/system/action') await systemAction(data);
      else if (pathname === '/api/volumes/action') await volumeAction(data);
      else if (pathname === '/api/places/action') await placeAction(data);
      else return send(res, 404, { error: 'Not found' });
      return send(res, 200, { status: 'ok' });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const stderr = err.stderr || '';
    if (!err.status && /not allowed to send keystrokes|\(1002\)|\(-1743\)|not authori[sz]ed/i.test(stderr)) {
      return send(res, 403, { error: 'macOS permission missing: allow DockWeb under Privacy & Security → Accessibility / Automation' });
    }
    send(res, err.status || 500, { error: err.status ? err.message : 'Command failed on the Mac' });
    if (!err.status) console.error(err.message, stderr.trim());
  }
});

server.listen(PORT, HOST, () => {
  const urls = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
  console.log('DockWeb running. Open on your phone (same Wi-Fi or Tailscale):');
  (urls.length ? urls : [`http://localhost:${PORT}`]).forEach(u => console.log('  ' + u));
  console.log(`PIN: ${config.pin}   (stored in config.json; override with DOCKWEB_PIN)`);
});

// Never let a stray error take the deck offline.
process.on('uncaughtException', err => console.error('uncaughtException:', err));
process.on('unhandledRejection', err => console.error('unhandledRejection:', err));

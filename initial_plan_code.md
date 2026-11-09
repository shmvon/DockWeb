



**DockWeb is a self-hosted, lightweight progressive web application that repurposes an iPhone into an interactive touch controller mirroring the macOS Dock, system controls, and external storage.**

It eliminates third-party streamer bloat and bypasses iOS developer signing limits by serving a local PWA directly from a zero-dependency macOS Node.js daemon.

## Primary goal

To provide a clean, native-feeling external touch deck on an iPhone that synchronizes dynamically with your Mac over the local network — giving you physical desktop controls, window orchestration, and peripheral management without ongoing subscriptions or proprietary companion clients.

## Core features

- **Dynamic dock synchronization:** Reads `com.apple.dock.plist` directly to mirror your current pinned applications and automatically converts native `.icns` assets to cached PNGs using `sips`.
- **Process state indicators:** Polls active GUI processes via `System Events` to render running-state indicators beneath each dock icon.
- **Contextual touch gestures:**
  - **Single tap:** Focuses or launches the target application via `/usr/bin/open`.
  - **Double tap:** Toggles fullscreen mode (`Cmd + Ctrl + F`).
  - **Long press:** Triggers App Exposé (`Ctrl + Down Arrow`) to inspect all open windows of that application.
  - **Swipe up:** Sends a graceful quit command to the application via AppleScript.
- **Media and system management:**
  - Transport controls for Apple Music or media playback (Play/Pause, Next, Previous).
  - Real-time sliders for macOS master volume and hardware display brightness.
- **Session and power controls:** Dedicated triggers for display sleep (`pmset`), system sleep, user log out, restart, and system shutdown.
- **External storage manager:** Monitors mounted volumes via `diskutil`, filters out internal APFS containers, and provides one-tap actions to open drives in Finder or safely unmount/eject external SSDs.
- **Native kiosk presentation:** Built with CSS scroll snap across three swipeable horizontal pages, fully optimized for standalone, edge-to-edge iOS Safari Home Screen mode.



# Initial code

This self-hosted system consists of a zero-dependency Node.js HTTP daemon running on macOS and a three-page responsive web client designed for iOS Safari in standalone PWA mode.

The server reads your dock preferences from `com.apple.dock.plist`, extracts application icons using `sips`, handles touch-gesture discrimination (tap, double tap, hold, swipe up), dispatches media and power events via `osascript` and `pmset`, and queries external mount points using `diskutil`.

## Project structure and setup

Place all files in a single directory on your Mac:

```text
dockweb/
├── server.js
└── index.html
```

Before running, satisfy these two operational requirements:

- **Accessibility permissions:** Grant Accessibility access to your terminal emulator (Terminal, iTerm2, or VS Code) in **System Settings — Privacy & Security — Accessibility** so `osascript` can dispatch keystrokes to `System Events`.
- **Display brightness CLI (optional):** To adjust hardware brightness from the web deck, install the standard brightness utility via Homebrew: `brew install brightness`.

Run the server with Node.js 18 or newer:

```bash
node server.js
```

## Backend implementation (server.js)

```javascript
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execSync } from 'node:child_process';
import os from 'node:os';

const PORT = 8080;
const ICONS_DIR = path.join(process.cwd(), '.cache', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

function getDockApps() {
  const plistPath = path.join(os.homedir(), 'Library/Preferences/com.apple.dock.plist');
  try {
    const rawJson = execSync(`plutil -extract persistent-apps json -o - "${plistPath}"`, { encoding: 'utf-8' });
    const items = JSON.parse(rawJson);
    return items.map(entry => {
      const tile = entry['tile-data'];
      const rawUrl = tile['file-data']?.['_CFURLString'] || '';
      const decodedPath = decodeURIComponent(rawUrl.replace(/^file:\/\//, '').replace(/\/$/, ''));
      return {
        label: tile['file-label'],
        path: decodedPath,
        bundleId: tile['bundle-identifier'] || ''
      };
    }).filter(item => item.path && fs.existsSync(item.path));
  } catch {
    return [];
  }
}

function getRunningProcessNames() {
  try {
    const cmd = "osascript -e 'tell application \"System Events\" to get name of every process whose background only is false'";
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(', ').map(s => s.trim().toLowerCase());
  } catch {
    return [];
  }
}

function ensurePngIcon(appPath, label) {
  const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetPng = path.join(ICONS_DIR, `${safeName}.png`);
  if (fs.existsSync(targetPng)) return `/icons/${safeName}.png`;

  try {
    const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
    let iconFile = 'AppIcon';
    if (fs.existsSync(infoPlist)) {
      try {
        const raw = execSync(`defaults read "${infoPlist}" CFBundleIconFile 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (raw) iconFile = raw.replace(/\.icns$/, '');
      } catch {}
    }

    let icnsPath = path.join(appPath, 'Contents', 'Resources', `${iconFile}.icns`);
    if (!fs.existsSync(icnsPath)) {
      const resFiles = fs.readdirSync(path.join(appPath, 'Contents', 'Resources'));
      const fallback = resFiles.find(f => f.endsWith('.icns'));
      if (fallback) icnsPath = path.join(appPath, 'Contents', 'Resources', fallback);
    }

    if (fs.existsSync(icnsPath)) {
      execSync(`sips -s format png "${icnsPath}" --out "${targetPng}" --resampleWidth 128 >/dev/null 2>&1`);
      return `/icons/${safeName}.png`;
    }
  } catch {}
  return null;
}

function getExternalVolumes() {
  try {
    const mounts = fs.readdirSync('/Volumes').filter(name => !name.startsWith('.') && name !== 'Macintosh HD');
    return mounts.map(name => {
      try {
        const fullPath = `/Volumes/${name}`;
        const plistRaw = execSync(`diskutil info -plist "${fullPath}"`, { encoding: 'utf-8' });
        const isInternal = plistRaw.includes('<key>Internal</key>\n\t<true/>');
        return {
          name,
          path: fullPath,
          isExternal: !isInternal
        };
      } catch {
        return null;
      }
    }).filter(v => v && v.isExternal);
  } catch {
    return [];
  }
}

function executeShell(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && parsedUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf-8'));
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/dock') {
    const apps = getDockApps();
    const running = getRunningProcessNames();
    const payload = apps.map(app => ({
      label: app.label,
      path: app.path,
      iconUrl: ensurePngIcon(app.path, app.label),
      isRunning: running.includes(app.label.toLowerCase())
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/volumes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getExternalVolumes()));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};

        // Dock gestures
        if (parsedUrl.pathname === '/api/dock/action') {
          const { action, appPath, appName } = data;
          if (action === 'select') await executeShell(`open "${appPath}"`);
          if (action === 'expose') await executeShell(`osascript -e 'tell application "System Events" to key code 125 using control down'`);
          if (action === 'fullscreen') await executeShell(`osascript -e 'tell application "System Events" to keystroke "f" using {command down, control down}'`);
          if (action === 'quit') await executeShell(`osascript -e 'tell application "${appName}" to quit'`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        // System, media, and power controls
        if (parsedUrl.pathname === '/api/system/action') {
          const { command, value } = data;
          if (command === 'playpause') await executeShell(`osascript -e 'tell application "Music" to playpause'`);
          if (command === 'next') await executeShell(`osascript -e 'tell application "Music" to next track'`);
          if (command === 'prev') await executeShell(`osascript -e 'tell application "Music" to previous track'`);
          if (command === 'volume') await executeShell(`osascript -e 'set volume output volume ${Number(value)}'`);
          if (command === 'brightness') await executeShell(`brightness ${Number(value) / 100}`);
          if (command === 'displaysleep') await executeShell(`pmset displaysleepnow`);
          if (command === 'sleep') await executeShell(`osascript -e 'tell application "System Events" to sleep'`);
          if (command === 'logout') await executeShell(`osascript -e 'tell application "System Events" to log out'`);
          if (command === 'restart') await executeShell(`osascript -e 'tell application "System Events" to restart'`);
          if (command === 'shutdown') await executeShell(`osascript -e 'tell application "System Events" to shut down'`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        // Volume management
        if (parsedUrl.pathname === '/api/volumes/action') {
          const { action, volumePath } = data;
          if (action === 'open') await executeShell(`open "${volumePath}"`);
          if (action === 'eject') await executeShell(`diskutil unmountDisk "${volumePath}"`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/icons/')) {
    const filePath = path.join(ICONS_DIR, path.basename(parsedUrl.pathname));
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Control deck server running at http://0.0.0.0:${PORT}`);
});
```

## Frontend implementation (index.html)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Desk Controller</title>
  <style>
    :root {
      --bg: #09090b;
      --card-bg: rgba(255, 255, 255, 0.05);
      --border: rgba(255, 255, 255, 0.1);
      --accent: #3b82f6;
      --text: #f4f4f5;
      --subtext: #a1a1aa;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif;
      overflow: hidden;
      user-select: none;
    }
    .viewport {
      display: flex;
      width: 100vw;
      height: 100vh;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scrollbar-width: none;
    }
    .viewport::-webkit-scrollbar { display: none; }
    .page {
      flex: 0 0 100vw;
      width: 100vw;
      height: 100vh;
      scroll-snap-align: start;
      padding: env(safe-area-inset-top) 20px env(safe-area-inset-bottom) 20px;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      overflow-y: auto;
    }
    .header {
      padding: 16px 0 12px 0;
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--subtext);
    }
    
    /* Page 1: Dock */
    .dock-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      padding-bottom: 24px;
    }
    .dock-tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 14px 6px 10px 6px;
      position: relative;
      touch-action: pan-x;
    }
    .dock-tile img {
      width: 52px;
      height: 52px;
      border-radius: 12px;
      pointer-events: none;
    }
    .dock-tile span {
      font-size: 11px;
      color: var(--subtext);
      margin-top: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 90%;
    }
    .status-dot {
      position: absolute;
      bottom: 4px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: transparent;
    }
    .status-dot.active { background: #fff; }

    /* Page 2: System */
    .card-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 20px;
    }
    .btn-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    .btn-row.power {
      grid-template-columns: repeat(2, 1fr);
    }
    button {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 12px;
      padding: 14px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    button:active { background: rgba(255, 255, 255, 0.15); }
    button.danger { color: var(--danger); }
    .slider-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .slider-card label {
      font-size: 12px;
      color: var(--subtext);
      display: flex;
      justify-content: space-between;
    }
    input[type=range] {
      width: 100%;
      accent-color: var(--accent);
    }

    /* Page 3: Volumes */
    .volume-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .volume-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 16px;
    }
    .volume-name { font-weight: 500; font-size: 15px; }
  </style>
</head>
<body>
  <div class="viewport">
    <!-- Page 1: Dock -->
    <div class="page" id="page-dock">
      <div class="header">Dock Mirror</div>
      <div class="dock-grid" id="dock-grid"></div>
    </div>

    <!-- Page 2: Controls -->
    <div class="page" id="page-controls">
      <div class="header">Media & System</div>
      <div class="card-section">
        <div class="btn-row">
          <button onclick="postSys('prev')">Prev</button>
          <button onclick="postSys('playpause')">Play/Pause</button>
          <button onclick="postSys('next')">Next</button>
        </div>
        <div class="slider-card">
          <label><span>System Volume</span><span id="vol-val">50%</span></label>
          <input type="range" min="0" max="100" value="50" onchange="postSys('volume', this.value); document.getElementById('vol-val').innerText = this.value + '%';">
        </div>
        <div class="slider-card">
          <label><span>Display Brightness</span><span id="bri-val">70%</span></label>
          <input type="range" min="0" max="100" value="70" onchange="postSys('brightness', this.value); document.getElementById('bri-val').innerText = this.value + '%';">
        </div>
      </div>

      <div class="header">Power & Session</div>
      <div class="card-section">
        <div class="btn-row power">
          <button onclick="postSys('displaysleep')">Sleep Display</button>
          <button onclick="postSys('sleep')">System Sleep</button>
          <button onclick="postSys('logout')">Log Out</button>
          <button onclick="postSys('restart')">Restart</button>
          <button class="danger" style="grid-column: span 2;" onclick="postSys('shutdown')">Shut Down</button>
        </div>
      </div>
    </div>

    <!-- Page 3: Volumes -->
    <div class="page" id="page-volumes">
      <div class="header">Connected Volumes</div>
      <div class="volume-list" id="volume-list"></div>
    </div>
  </div>

  <script>
    async function postJson(url, data) {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    }

    function postSys(command, value = null) {
      postJson('/api/system/action', { command, value });
    }

    // Dock rendering and gesture engine
    async function loadDock() {
      const res = await fetch('/api/dock');
      const apps = await res.json();
      const grid = document.getElementById('dock-grid');
      grid.innerHTML = '';

      apps.forEach(app => {
        const tile = document.createElement('div');
        tile.className = 'dock-tile';

        tile.innerHTML = `
          <img src="${app.iconUrl || ''}" alt="${app.label}">
          <span>${app.label}</span>
          <div class="status-dot ${app.isRunning ? 'active' : ''}"></div>
        `;

        let timer = null;
        let startY = 0;
        let lastTap = 0;

        tile.addEventListener('touchstart', (e) => {
          startY = e.touches[0].clientY;
          timer = setTimeout(() => {
            timer = null;
            postJson('/api/dock/action', { action: 'expose', appName: app.label });
          }, 500);
        });

        tile.addEventListener('touchend', (e) => {
          const deltaY = e.changedTouches[0].clientY - startY;
          const now = Date.now();

          if (timer) {
            clearTimeout(timer);
            timer = null;

            if (deltaY < -50) {
              postJson('/api/dock/action', { action: 'quit', appName: app.label });
            } else if (now - lastTap < 300) {
              postJson('/api/dock/action', { action: 'fullscreen', appName: app.label });
            } else {
              postJson('/api/dock/action', { action: 'select', appPath: app.path });
            }
          }
          lastTap = now;
        });

        grid.appendChild(tile);
      });
    }

    // Storage rendering
    async function loadVolumes() {
      const res = await fetch('/api/volumes');
      const volumes = await res.json();
      const list = document.getElementById('volume-list');
      list.innerHTML = '';

      if (volumes.length === 0) {
        list.innerHTML = '<div style="color: var(--subtext); font-size: 14px;">No external drives detected.</div>';
        return;
      }

      volumes.forEach(vol => {
        const card = document.createElement('div');
        card.className = 'volume-card';
        card.innerHTML = `
          <div class="volume-name" onclick="postJson('/api/volumes/action', { action: 'open', volumePath: '${vol.path}' })">${vol.name}</div>
          <button onclick="postJson('/api/volumes/action', { action: 'eject', volumePath: '${vol.path}' }); setTimeout(loadVolumes, 800);">Eject</button>
        `;
        list.appendChild(card);
      });
    }

    loadDock();
    loadVolumes();
    setInterval(loadDock, 5000);
    setInterval(loadVolumes, 5000);
  </script>
</body>
</html>
```
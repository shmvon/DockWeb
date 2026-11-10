# DockWeb

A self-hosted touch deck for your Mac, on any phone or tablet browser (Android, iPhone, iPad).
It mirrors your Dock, gives you media and power keys, and opens folders and external drives on the Mac.
No dependencies beyond Node.js 18+.

| Page | What it does |
|---|---|
| 1. **Media & power** | Icon tiles like the Dock: play/pause, previous/next, mute, volume, display sleep, brightness; sleep, restart, shut down, log out (destructive actions need a second tap) |
| 2. **Dock** (start page) | Finder, your pinned apps and other running apps, with running-dots. Tap: bring to front (tap again to hide) · double tap: App Exposé · hold: full screen · triple tap: quit |
| 3. **Folders & drives** | Open Desktop, Documents, Downloads, iCloud Drive, Google Drive and OneDrive in Finder; tap a drive to open it, ⏏︎ to eject |
| 4. **Interface** | Hide section titles, icon labels or running markers (saved per phone) |

The layout adapts to the screen: 4 columns on a portrait phone, more in landscape or on a tablet.
Swipe sideways (or use the dots / arrow keys) to switch pages.

## Install (Mac app)

```bash
git clone https://github.com/shmvon/DockWeb.git
cd DockWeb
./build.sh
open /Applications/DockWeb.app
```

`build.sh` compiles a small menu-bar launcher (needs the Xcode Command Line Tools: `xcode-select --install`) and bundles
the server into `/Applications/DockWeb.app`. Use `./build.sh --no-install` to build into `./dist` instead.

DockWeb then lives in the **menu bar**. Its menu shows the addresses to open on your phone, the PIN (click to copy),
an **Open at Login** toggle, the log and a restart button.

### macOS permissions (one-time)

- **Accessibility** for *DockWeb*: needed for media keys, App Exposé and fullscreen. The app asks on first launch;
  you can also use the menu item or *System Settings → Privacy & Security → Accessibility*.
- **Automation → System Events**: macOS asks once, the first time you use Log Out, Restart or Shut Down.

Because the permission belongs to the app rather than to whichever terminal started `node`, macOS keeps it.
`build.sh` signs with your first code-signing identity if you have one (set `DOCKWEB_SIGN_ID` to choose); with
ad-hoc signing, macOS treats every rebuild as a new app and you have to re-allow Accessibility.

## Connect your phone

1. Open one of the addresses from the menu-bar icon (e.g. `http://192.168.1.20:8511`) on your phone, on the same Wi-Fi.
2. Enter the PIN.
3. Add it to your home screen for a full-screen app: Android Chrome *⋮ → Add to Home screen*; iPhone Safari *Share → Add to Home Screen*.

On networks that isolate devices (universities, cafés), use Tailscale: see [TAILSCALE.md](TAILSCALE.md).

## Run without the app (development)

```bash
node server.js
```

It prints the addresses and PIN. Environment variables: `PORT` (default 8511), `HOST` (default `0.0.0.0`),
`DOCKWEB_PIN` (use a fixed PIN, never written to disk), `DOCKWEB_DATA` (folder for `config.json` and the icon cache;
the app uses `~/Library/Application Support/DockWeb`). When run this way, macOS permissions go to your terminal app, and media/keyboard buttons are unavailable
(those events are posted by the `DockWeb.app` binary).


## Security

- PIN login issues an HttpOnly session cookie; 5 wrong PINs lock out an IP for 60 s.
- Commands run via `execFile` (no shell). The phone only sends IDs that the server resolves against the live Dock,
  the fixed folder list and mounted volumes; it can't name arbitrary paths or apps.
- Traffic is plain HTTP: use it only on a network you trust, or over Tailscale. Never expose the port to the internet.

## Files

| Path | Purpose |
|---|---|
| `server.js` | HTTP server and API |
| `index.html` | The phone UI (single page, no build step) |
| `scripts/*.js` | JXA helpers: Dock contents, running apps, icons, quitting apps (key and media events are posted by the app binary, `DockWeb --keys`) |
| `macos/` | Menu-bar launcher (Swift) and `Info.plist` |
| `build.sh` | Builds `DockWeb.app` |
| `icon-png.js` | Draws the DockWeb icon (PWA and app icon) |

## License

[GNU Affero General Public License v3.0](LICENSE).

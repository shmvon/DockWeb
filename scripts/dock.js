// Print the Dock's pinned apps as JSON: [{label, url, bundleId}]
// Usage: osascript -l JavaScript scripts/dock.js <path to com.apple.dock.plist>
ObjC.import('Foundation');

function run(argv) {
  const root = $.NSDictionary.dictionaryWithContentsOfFile(argv[0]);
  const apps = root.objectForKey('persistent-apps');
  const out = [];
  for (let i = 0; i < apps.count; i++) {
    const tile = apps.objectAtIndex(i).objectForKey('tile-data');
    if (!tile || !tile.objectForKey('file-data')) continue;
    const str = k => { const v = tile.objectForKey(k); return v ? ObjC.unwrap(v) : ''; };
    out.push({
      label: str('file-label'),
      url: ObjC.unwrap(tile.objectForKey('file-data').objectForKey('_CFURLString')),
      bundleId: str('bundle-identifier')
    });
  }
  return JSON.stringify(out);
}

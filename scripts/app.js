// Quit or hide running app(s) by bundle id, like the Dock does. No Automation permission needed.
// Usage: osascript -l JavaScript scripts/app.js quit <bundle id>
//        osascript -l JavaScript scripts/app.js hide-if-front <bundle id>   prints "hidden" or "notfront"
ObjC.import('AppKit');

function run(argv) {
  const [action, bundleId] = argv;
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
  const list = [];
  for (let i = 0; i < apps.count; i++) list.push(apps.objectAtIndex(i));
  if (action === 'quit') { list.forEach(a => a.terminate); return String(list.length); }
  if (action === 'hide-if-front') {
    const front = list.filter(a => a.active);
    front.forEach(a => a.hide);
    return front.length ? 'hidden' : 'notfront';
  }
  throw new Error('usage');
}

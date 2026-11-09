// Ask running app(s) with a bundle id to quit, like Dock → Quit. No Automation permission needed.
// Usage: osascript -l JavaScript scripts/quit.js <bundle id>
ObjC.import('AppKit');

function run(argv) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  for (let i = 0; i < apps.count; i++) apps.objectAtIndex(i).terminate;
  return String(apps.count);
}

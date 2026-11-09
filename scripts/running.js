// Print regular (Dock-visible) running apps as JSON: [{bundleId, path, name}]
// Usage: osascript -l JavaScript scripts/running.js
ObjC.import('AppKit');

function run() {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const out = [];
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    if (Number(a.activationPolicy) !== 0 /* NSApplicationActivationPolicyRegular */ || a.bundleURL.isNil()) continue;
    out.push({
      bundleId: a.bundleIdentifier.isNil() ? '' : ObjC.unwrap(a.bundleIdentifier),
      path: ObjC.unwrap(a.bundleURL.path),
      name: a.localizedName.isNil() ? '' : ObjC.unwrap(a.localizedName)
    });
  }
  return JSON.stringify(out);
}

// Post keyboard input without System Events (needs only Accessibility for the host app).
// Usage:
//   osascript -l JavaScript scripts/keys.js media <NX_KEYTYPE>     0 vol up, 1 vol down, 7 mute, 16 play/pause, 17 next, 18 prev
//   osascript -l JavaScript scripts/keys.js key <keycode> [mods]   mods: comma list of cmd,ctrl,alt,shift
// Prints "ok", or "noperm" when macOS would silently drop the events.
ObjC.import('AppKit');
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);

const MODS = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 };

function media(key, down) {
  const flags = down ? 0xa00 : 0xb00;
  const ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
    14 /* NSEventTypeSystemDefined */, $.NSMakePoint(0, 0), flags, 0, 0, $(), 8, (key << 16) | flags, -1);
  $.CGEventPost(0 /* kCGHIDEventTap */, ev.CGEvent);
}

function key(code, mods) {
  const flags = mods.reduce((f, m) => f | (MODS[m] || 0), 0);
  for (const down of [true, false]) {
    const ev = $.CGEventCreateKeyboardEvent($(), code, down);
    $.CGEventSetFlags(ev, flags);
    $.CGEventPost(0, ev);
  }
}

function run(argv) {
  if (!$.AXIsProcessTrusted()) return 'noperm';
  if (argv[0] === 'media') { const k = parseInt(argv[1], 10); media(k, true); media(k, false); }
  else if (argv[0] === 'key') key(parseInt(argv[1], 10), (argv[2] || '').split(',').filter(Boolean));
  else throw new Error('usage');
  return 'ok';
}

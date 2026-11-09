// Render an app's icon (any format, incl. Assets.car) to a square PNG of an exact pixel size.
// Usage: osascript -l JavaScript scripts/icon.js <app path> <out.png> [size=256]
ObjC.import('AppKit');

function run(argv) {
  const size = parseInt(argv[2] || '256', 10);
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  rep.setSize($.NSMakeSize(size, size));
  $.NSGraphicsContext.saveGraphicsState;
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  ctx.setImageInterpolation(3); // NSImageInterpolationHigh
  $.NSGraphicsContext.setCurrentContext(ctx);
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, 2 /* sourceOver */, 1);
  ctx.flushGraphics;
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties(4 /* PNG */, $({}));
  if (!png.writeToFileAtomically(argv[1], true)) throw new Error('write failed');
  return 'ok';
}

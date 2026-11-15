import AppKit

// Ask the same system service Finder uses for the finished app's icon.
// This exercises Info.plist and compiled resources, not the source SVG.
guard CommandLine.arguments.count == 3 else { fatalError("Expected app path and output PNG") }
let icon = NSWorkspace.shared.icon(forFile: CommandLine.arguments[1])
let size = 1024
guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
    let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot create icon canvas") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
icon.draw(in: NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)), from: .zero,
    operation: .copy, fraction: 1)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Cannot encode icon") }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))

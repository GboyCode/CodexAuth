import AppKit
// A separate native application for focus-transfer integration tests only.
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 240, height: 160),
    styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "CodexAuth focus test"
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()

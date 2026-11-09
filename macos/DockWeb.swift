// DockWeb.app: a menu-bar launcher that runs the DockWeb Node server bundled in Contents/Resources/server.
// Running from a signed .app gives macOS one stable identity to grant Accessibility to, instead of
// whichever terminal happened to start `node`.
import AppKit
import ApplicationServices
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let port = UserDefaults.standard.integer(forKey: "port") > 0 ? UserDefaults.standard.integer(forKey: "port") : 8511
    private let fm = FileManager.default
    private lazy var dataDir = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/DockWeb")
    private lazy var logURL = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/DockWeb.log")
    private var statusItem: NSStatusItem!
    private var server: Process?
    private var log: FileHandle?
    private var buffer = ""
    private var urls: [String] = []
    private var pin = ""
    private var status = "Starting…"
    private var quitting = false
    private var restartDelay: TimeInterval = 1

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let image = NSImage(systemSymbolName: "square.grid.3x3.fill", accessibilityDescription: "DockWeb")
        image?.isTemplate = true
        statusItem.button?.image = image
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()

        // Ask once; macOS shows its own prompt that links to System Settings.
        if !AXIsProcessTrusted() {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        }
        startServer()
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        if let s = server, s.isRunning { s.terminate(); s.waitUntilExit() }
    }

    // MARK: server

    private func findNode() -> String? {
        var candidates: [String] = []
        if let baked = Bundle.main.object(forInfoDictionaryKey: "DockWebNodePath") as? String { candidates.append(baked) }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        let home = fm.homeDirectoryForCurrentUser.path
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            let sorted = versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            candidates += sorted.map { "\(nvm)/\($0)/bin/node" }
        }
        candidates += ["\(home)/.volta/bin/node", "\(home)/.local/share/fnm/aliases/default/bin/node", "/usr/bin/node"]
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }

    /// Stop a DockWeb server left over from a previous run (or the old .command launcher).
    private func freePort() {
        let out = shell("/usr/sbin/lsof", ["-tiTCP:\(port)", "-sTCP:LISTEN"])
        for pidStr in out.split(separator: "\n") {
            guard let pid = Int32(pidStr) else { continue }
            if shell("/bin/ps", ["-p", String(pid), "-o", "command="]).contains("server.js") {
                kill(pid, SIGTERM)
                usleep(500_000)
            }
        }
    }

    private func startServer() {
        guard let resources = Bundle.main.resourceURL?.appendingPathComponent("server"),
              fm.fileExists(atPath: resources.appendingPathComponent("server.js").path) else {
            return fail("Server files missing from the app bundle. Rebuild with build.sh.")
        }
        guard let node = findNode() else {
            return fail("Node.js 18+ not found. Install it (brew install node), then Restart Server.")
        }
        freePort()
        urls = []; pin = ""; status = "Starting…"; buffer = ""

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [resources.appendingPathComponent("server.js").path]
        p.currentDirectoryURL = resources
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(URL(fileURLWithPath: node).deletingLastPathComponent().path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["DOCKWEB_DATA"] = dataDir.path
        env["PORT"] = String(port)
        p.environment = env

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { h.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.serverExited(code: proc.terminationStatus) }
        }
        do {
            try p.run()
            server = p
            writeLog("--- started node \(node) on port \(port)\n")
        } catch {
            fail("Could not start node: \(error.localizedDescription)")
        }
    }

    private func consume(_ data: Data) {
        log?.write(data)
        buffer += String(decoding: data, as: UTF8.self)
        while let nl = buffer.firstIndex(of: "\n") {
            let line = buffer[..<nl].trimmingCharacters(in: .whitespaces)
            buffer.removeSubrange(...nl)
            if line.hasPrefix("http://") { urls.append(line); status = "Running on port \(port)"; restartDelay = 1 }
            else if line.hasPrefix("PIN:") { pin = String(line.dropFirst(4).trimmingCharacters(in: .whitespaces).prefix { !$0.isWhitespace }) }
            else if line.contains("EADDRINUSE") { status = "Port \(port) is in use by another app" }
        }
    }

    private func serverExited(code: Int32) {
        server = nil
        writeLog("--- server exited with code \(code)\n")
        guard !quitting else { return }
        if !status.hasPrefix("Port") { status = "Server stopped, restarting…" }
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.quitting, self.server == nil else { return }
            self.startServer()
        }
    }

    private func fail(_ message: String) {
        status = message
        writeLog("!!! \(message)\n")
    }

    private func writeLog(_ s: String) { log?.write(Data(s.utf8)) }

    @discardableResult
    private func shell(_ cmd: String, _ args: [String]) -> String {
        let p = Process(), pipe = Pipe()
        p.executableURL = URL(fileURLWithPath: cmd)
        p.arguments = args
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let header = NSMenuItem(title: "DockWeb: \(status)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        if !urls.isEmpty {
            menu.addItem(.separator())
            menu.addItem(disabled("Open on your phone (click to copy):"))
            for u in urls { menu.addItem(item(u, #selector(copyItem(_:)), represented: u)) }
        }
        if !pin.isEmpty { menu.addItem(item("PIN: \(pin)", #selector(copyItem(_:)), represented: pin)) }

        menu.addItem(.separator())
        menu.addItem(item("Open in Browser", #selector(openBrowser)))
        if AXIsProcessTrusted() {
            menu.addItem(disabled("✓ Accessibility allowed"))
        } else {
            menu.addItem(item("⚠︎ Allow Accessibility (media keys, gestures)…", #selector(openAccessibility)))
        }
        let login = item("Open at Login", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(item("Show Log", #selector(showLog)))
        menu.addItem(item("Restart Server", #selector(restartServer)))
        menu.addItem(.separator())
        menu.addItem(item("Quit DockWeb", #selector(quit), key: "q"))
    }

    private func item(_ title: String, _ action: Selector, represented: Any? = nil, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        i.representedObject = represented
        return i
    }
    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    @objc private func copyItem(_ sender: NSMenuItem) {
        guard let s = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }
    @objc private func openBrowser() { NSWorkspace.shared.open(URL(string: "http://localhost:\(port)")!) }
    @objc private func openAccessibility() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
    @objc private func showLog() { NSWorkspace.shared.open(logURL) }
    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change Open at Login"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
    @objc private func restartServer() {
        restartDelay = 1
        if let s = server, s.isRunning { s.terminate() } else { startServer() }
    }
    @objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

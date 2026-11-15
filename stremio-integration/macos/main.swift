import AppKit

final class IntegrationWindow: NSWindowController {
    private let client = NSPopUpButton()
    private let address = NSTextField(string: "http://127.0.0.1:9091/transmission/rpc")
    private let username = NSTextField(string: "")
    private let password = NSSecureTextField(string: "")
    private let cache = NSTextField(string: NSHomeDirectory() + "/Library/Application Support/stremio-server/stremio-cache")
    private let destination = NSTextField(string: NSHomeDirectory() + "/Downloads/Seme")
    private let status = NSTextField(wrappingLabelWithString: "Checking installation…")
    private var buttons: [NSButton] = []
    private var saved: [String: Any] = [:]
    private let configFile = NSHomeDirectory() + "/Library/Application Support/Seme/integration/config.json"
    private let node = "/Applications/Stremio.app/Contents/MacOS/node"
    private var busy = false
    private var screenshotMode = false
    private var signatureNotice: String { "Installing changes Stremio’s signed server.js and invalidates its code signature. macOS may block the modified app. Sème never re-signs Stremio. Uninstall restores the exact original file if it has not changed; reinstalling Stremio also removes the integration." }

    init(screenshot: Bool = false) {
        screenshotMode = screenshot
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 740), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Sème Setup"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        client.addItems(withTitles: ["Transmission", "qBittorrent", "Deluge"])
        client.bezelStyle = .rounded
        client.target = self; client.action = #selector(clientChanged)
        if !screenshot { loadSaved() }
        buildLayout()
        window.center()
        if !screenshot {
            if saved.isEmpty { run("defaults", success: { self.run("status") }) }
            else { run("status") }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func loadSaved() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: configFile)), data.count <= 65536,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        saved = object
        if let value = object["cacheDir"] as? String { cache.stringValue = value }
        if let value = object["destinationDir"] as? String { destination.stringValue = value }
        if let value = object["client"] as? [String: Any] {
            let types = ["transmission", "qbittorrent", "deluge"]
            if let type = value["type"] as? String, let index = types.firstIndex(of: type) { client.selectItem(at: index) }
            address.stringValue = value["url"] as? String ?? address.stringValue
            username.stringValue = value["username"] as? String ?? ""
            password.stringValue = value["password"] as? String ?? ""
        }
    }
    private func buildLayout() {
        guard let root = window?.contentView else { return }
        let brand = NSTextField(labelWithString: "SÈME  ·  STREMIO INTEGRATION")
        brand.font = .systemFont(ofSize: 11, weight: .semibold); brand.textColor = .secondaryLabelColor
        let heading = NSTextField(labelWithString: "Keep sharing what you watch.")
        heading.font = .systemFont(ofSize: 26, weight: .semibold)
        let intro = label("Sème runs inside Stremio and hands completed videos to your torrent client. This setup window can be closed after installation.")
        let clientRow = NSStackView(views: [NSTextField(labelWithString: "Torrent client"), client])
        clientRow.spacing = 14
        let cacheRow = folderRow(cache, action: #selector(chooseCache))
        let destinationRow = folderRow(destination, action: #selector(chooseDestination))
        let save = button("Save settings", action: #selector(saveSettings))
        let test = button("Test connection", action: #selector(testConnection))
        let install = button("Install integration", action: #selector(installIntegration))
        let uninstall = button("Uninstall", action: #selector(uninstallIntegration))
        let refresh = button("Refresh status", action: #selector(refreshStatus))
        let actions = NSStackView(views: [save, test, install, uninstall])
        actions.spacing = 8
        let hint = label("Enable your client’s Web UI / RPC access, using local paths. Choose Stremio’s active cache folder and a separate permanent folder accessible to your client. Save settings before installing. Quit Stremio before installing or uninstalling, then reopen it.")
        let warning = label(signatureNotice)
        warning.font = .systemFont(ofSize: 11)
        warning.textColor = .secondaryLabelColor
        status.maximumNumberOfLines = 6; status.font = .systemFont(ofSize: 12)
        let stack = NSStackView(views: [brand, heading, intro, clientRow,
            field("Web UI / RPC address", address), field("Username", username), field("Password", password),
            field("Stremio cache folder", cacheRow), field("Permanent seeding folder", destinationRow), hint, actions, refresh, status, warning])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 26),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor, constant: -24)
        ])
        for view in stack.arrangedSubviews where view !== brand && view !== heading && view !== clientRow && view !== actions && view !== refresh {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }
    private func label(_ value: String) -> NSTextField {
        let result = NSTextField(wrappingLabelWithString: value)
        result.font = .systemFont(ofSize: 12); result.maximumNumberOfLines = 0
        return result
    }
    private func field(_ title: String, _ view: NSView) -> NSView {
        let caption = NSTextField(labelWithString: title); caption.font = .systemFont(ofSize: 11, weight: .medium)
        let row = NSStackView(views: [caption, view]); row.orientation = .vertical; row.alignment = .leading; row.spacing = 3
        view.widthAnchor.constraint(equalTo: row.widthAnchor).isActive = true
        return row
    }
    private func folderRow(_ text: NSTextField, action: Selector) -> NSView {
        text.isEditable = false; text.lineBreakMode = .byTruncatingMiddle
        let choose = button("Choose…", action: action)
        let row = NSStackView(views: [text, choose]); row.spacing = 8
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return row
    }
    private func button(_ title: String, action: Selector) -> NSButton {
        let result = NSButton(title: title, target: self, action: action); result.bezelStyle = .rounded; buttons.append(result); return result
    }
    @objc private func clientChanged() {
        let urls = ["http://127.0.0.1:9091/transmission/rpc", "http://127.0.0.1:8080", "http://127.0.0.1:8112/json"]
        address.stringValue = urls[client.indexOfSelectedItem]
    }
    private func formConfig() -> [String: Any] {
        var result = saved
        result["enabled"] = true
        result["cacheDir"] = cache.stringValue
        result["destinationDir"] = destination.stringValue
        result["minFreeBytes"] = saved["minFreeBytes"] ?? 2147483648
        result["intervalSeconds"] = saved["intervalSeconds"] ?? 30
        result["client"] = ["type": ["transmission", "qbittorrent", "deluge"][client.indexOfSelectedItem],
                            "url": address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
                            "username": username.stringValue, "password": password.stringValue]
        return result
    }
    private func choose(_ target: NSTextField) {
        guard !busy, let window else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.canCreateDirectories = true; panel.allowsMultipleSelection = false; panel.prompt = "Choose folder"
        panel.directoryURL = URL(fileURLWithPath: target.stringValue)
        panel.beginSheetModal(for: window) { response in
            if response == .OK, let url = panel.url { target.stringValue = url.path }
        }
    }
    @objc private func chooseCache() { choose(cache) }
    @objc private func chooseDestination() { choose(destination) }
    @objc private func saveSettings() { let value = formConfig(); run("configure", input: value) { self.saved = value } }
    @objc private func testConnection() { run("test-client", input: formConfig()) }
    @objc private func installIntegration() {
        let value = formConfig()
        run("configure", input: value) { self.saved = value; self.run("install") }
    }
    @objc private func uninstallIntegration() { run("uninstall") }
    @objc private func refreshStatus() { run("status") }
    private func run(_ command: String, input: [String: Any]? = nil, success: (() -> Void)? = nil) {
        guard !busy else { return }
        guard FileManager.default.isExecutableFile(atPath: node),
              let resource = Bundle.main.resourceURL else {
            show("Install Stremio in /Applications first. Its bundled Node runtime is required.", error: true); return
        }
        let cli = resource.appendingPathComponent("stremio-integration/cli.cjs").path
        let payload: Data
        do { payload = try input.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data() }
        catch { show("Could not encode settings.", error: true); return }
        busy = true; buttons.forEach { $0.isEnabled = false }; client.isEnabled = false
        [address, username, password].forEach { $0.isEnabled = false }
        show(command == "status" ? "Checking integration…" : "Working…")
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process(); let output = Pipe(); let incoming = Pipe()
            process.executableURL = URL(fileURLWithPath: self.node)
            process.arguments = [cli, command]
            process.standardInput = incoming; process.standardOutput = output; process.standardError = FileHandle.nullDevice
            var response: [String: Any] = [:]
            do {
                try process.run()
                incoming.fileHandleForWriting.write(payload); try? incoming.fileHandleForWriting.close()
                let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: deadline)
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit(); deadline.cancel()
                if data.count < 65536, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { response = object }
                else { response = ["ok": false, "error": "The setup command did not return a valid response."] }
                if process.terminationStatus != 0 && response["error"] == nil { response = ["ok": false, "error": "The setup command failed or timed out."] }
            } catch { response = ["ok": false, "error": "Could not start Stremio’s Node runtime."] }
            DispatchQueue.main.async {
                self.busy = false; self.buttons.forEach { $0.isEnabled = true }; self.client.isEnabled = true
                [self.address, self.username, self.password].forEach { $0.isEnabled = true }
                if let error = response["error"] as? String { self.show(error, error: true); return }
                if let defaults = response["defaults"] as? [String: Any], self.saved.isEmpty {
                    self.cache.stringValue = defaults["cacheDir"] as? String ?? self.cache.stringValue
                    self.destination.stringValue = defaults["destinationDir"] as? String ?? self.destination.stringValue
                    self.show("Default folders detected. Choose your torrent client.")
                } else if let state = response["state"] as? String {
                    let descriptions = ["installed": "Integration installed. Reopen Stremio to load it.", "restored": "Original Stremio file restored. Integration is uninstalled.", "not-installed": "Integration is not installed.", "changed": "Stremio changed since installation. Nothing will be overwritten. Reinstall Stremio or inspect the change before adopting it using the CLI.", "unknown-hook": "An unrecognized integration hook is present. Restore Stremio before installing."]
                    var message = descriptions[state] ?? state
                    if response["running"] as? Bool == true { message += " Quit Stremio completely before changing the integration." }
                    var runtimeError = false
                    if let runtime = response["runtime"] as? [String: Any], let timestamp = runtime["lastScan"] as? String {
                        message += "\nLast scan: " + timestamp + ". Imported: \(runtime["imported"] as? Int ?? 0)."
                        if let errors = runtime["errors"] as? [[String: Any]], let first = errors.first {
                            let code = first["code"] as? String ?? "RUNTIME_ERROR"
                            let help: String
                            switch code {
                            case "AMBIGUOUS_ADD": help = "Inspect the paused torrent in your client before continuing; its addition could not be confirmed."
                            case "UNSUPPORTED_STORAGE": help = "Disable your client’s separate incomplete-folder setting before transferring cache files."
                            default: help = "Check the torrent client and refresh status."
                            }
                            message += "\n" + code + ": " + help
                            runtimeError = true
                        }
                    }
                    self.show(message, error: runtimeError || state == "changed" || state == "unknown-hook")
                } else { self.show(response["message"] as? String ?? "Done.") }
                success?()
            }
        }
    }
    private func show(_ message: String, error: Bool = false) { status.stringValue = message; status.textColor = error ? .systemRed : .secondaryLabelColor }
    func screenshot(to file: URL) throws {
        show("Integration is not installed. Save settings, test your client, then install.")
        guard let view = window?.contentView else { return }
        view.layoutSubtreeIfNeeded(); window?.display()
        // Capture only this app's window; this includes modern AppKit controls
        // whose layers are omitted from PDF / cacheDisplay rendering.
        if let window {
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), file.path]
            capture.standardError = FileHandle.nullDevice
            try capture.run(); capture.waitUntilExit()
            if capture.terminationStatus == 0 { return }
        }
        let data = view.dataWithPDF(inside: view.bounds)
        guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider), let page = document.page(at: 1),
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(view.bounds.width * 2), pixelsHigh: Int(view.bounds.height * 2), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap)?.cgContext else { return }
        context.scaleBy(x: 2, y: 2); context.setFillColor(CGColor(gray: 0.96, alpha: 1)); context.fill(view.bounds); context.drawPDFPage(page)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
        try png.write(to: file)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var setup: IntegrationWindow?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--screenshot"), arguments.count > index + 1 {
            setup = IntegrationWindow(screenshot: true)
            setup?.showWindow(nil); NSApp.activate(ignoringOtherApps: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                do { try self.setup?.screenshot(to: URL(fileURLWithPath: arguments[index + 1])) }
                catch { fputs("Could not render setup window.\n", stderr) }
                NSApp.terminate(nil)
            }
            return
        }
        setup = IntegrationWindow(); setup?.showWindow(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
let menu = NSMenu(); let appItem = NSMenuItem(); let appMenu = NSMenu()
appMenu.addItem(withTitle: "Quit Sème Setup", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu; menu.addItem(appItem)
let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
let editMenu = NSMenu(title: "Edit")
for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
    editMenu.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
}
editItem.submenu = editMenu; menu.addItem(editItem)
app.mainMenu = menu
app.run()

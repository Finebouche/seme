import AppKit

@MainActor
final class SetupWindow: NSWindowController, NSTextFieldDelegate {
    private let api: DesktopAPI
    private var config: [String: Any]
    private let finished: () -> Void
    private var step = 0
    private var testedConnection: [String: String]?
    private var busy = false
    private var createDefaultDirectory = true
    private let defaultDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads/Seme", isDirectory: true)
    private var selectedDirectory: URL
    private let content = NSStackView()
    private let heading = NSTextField(labelWithString: "")
    private let subtitle = NSTextField(wrappingLabelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let back = NSButton(title: "Back", target: nil, action: nil)
    private let next = NSButton(title: "Continue", target: nil, action: nil)
    private let address = NSTextField(string: "http://127.0.0.1:9091/transmission/rpc")
    private let username = NSTextField(string: "")
    private let password = NSSecureTextField(string: "")
    private let torrentio = NSTextField(string: "https://torrentio.strem.fun")
    private let directoryLabel = NSTextField(wrappingLabelWithString: "")
    private var testButton: NSButton!

    init(api: DesktopAPI, config: [String: Any], finished: @escaping () -> Void) {
        self.api = api
        self.config = config
        self.finished = finished
        self.selectedDirectory = defaultDirectory
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Set up Sème"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        if let saved = config["transmission"] as? [String: Any] {
            address.stringValue = saved["url"] as? String ?? address.stringValue
            username.stringValue = saved["username"] as? String ?? ""
            // Masks round-trip through the API without exposing the stored password.
            password.stringValue = saved["password"] as? String ?? ""
            if let path = saved["download_dir"] as? String, !path.isEmpty,
               FileManager.default.fileExists(atPath: path) {
                selectedDirectory = URL(fileURLWithPath: path, isDirectory: true)
                createDefaultDirectory = false
            }
        }
        if let saved = config["torrentio"] as? [String: Any], let url = saved["url"] as? String, !url.isEmpty {
            torrentio.stringValue = url
        }
        [address, username, password].forEach { $0.delegate = self }
        buildLayout()
        render()
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func buildLayout() {
        guard let root = window?.contentView else { return }
        let brand = NSTextField(labelWithString: "SÈME  ·  FIRST-RUN SETUP")
        brand.font = .systemFont(ofSize: 12, weight: .semibold)
        brand.textColor = .secondaryLabelColor
        heading.font = .systemFont(ofSize: 29, weight: .semibold)
        subtitle.font = .systemFont(ofSize: 14)
        subtitle.textColor = .secondaryLabelColor
        subtitle.maximumNumberOfLines = 0
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 10
        status.font = .systemFont(ofSize: 12)
        status.maximumNumberOfLines = 0
        back.target = self
        back.action = #selector(previousStep)
        next.target = self
        next.action = #selector(nextStep)
        next.keyEquivalent = "\r"
        let spacer = NSView()
        let buttons = NSStackView(views: [back, spacer, next])
        buttons.orientation = .horizontal
        buttons.distribution = .fill
        let stack = NSStackView(views: [brand, heading, subtitle, content, NSView(), status, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -32),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 30),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -26),
            subtitle.widthAnchor.constraint(equalTo: stack.widthAnchor),
            content.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            spacer.widthAnchor.constraint(greaterThanOrEqualToConstant: 100)
        ])
    }

    private func render() {
        content.arrangedSubviews.forEach { content.removeArrangedSubview($0); $0.removeFromSuperview() }
        status.stringValue = ""
        back.isHidden = step == 0
        next.title = step == 2 ? "Finish setup" : "Continue"
        next.isEnabled = true
        switch step {
        case 0:
            heading.stringValue = "Your films, growing together."
            subtitle.stringValue = "Connect Stremio to the Transmission app on your Mac in a few steps."
            addText("1  Connect to Transmission", bold: true)
            addText("Sème uses your existing Transmission app to download and share the file you watch.")
            addText("2  Choose your download folder", bold: true)
            addText("You decide where files live. Automatic removal is disabled by this setup.")
            addText("3  Install Sème in Stremio", bold: true)
            addText("Sème stays in your menu bar. Closing its window keeps it available to Stremio. Transmission continues seeding independently when you quit Sème.")
        case 1:
            heading.stringValue = "Connect Transmission"
            subtitle.stringValue = "Step 1 of 2 · Sème needs local remote-control access."
            let installed = transmissionURL() != nil
            addText(installed ? "Transmission is installed on this Mac." : "Install Transmission first, then return here.", bold: true)
            addText("Open Transmission → Settings → Remote and enable remote access. Keep access limited to this Mac (127.0.0.1). If authentication is required, enter the same username and password below.")
            let open = NSButton(title: installed ? "Open Transmission" : "Get Transmission", target: self, action: #selector(openTransmission))
            content.addArrangedSubview(open)
            addField("RPC address", field: address)
            addField("Username (if required)", field: username)
            addField("Password (if required)", field: password)
            testButton = NSButton(title: "Test connection", target: self, action: #selector(testConnection))
            content.addArrangedSubview(testButton)
            next.isEnabled = testedConnection == connectionValues()
            if next.isEnabled { status.stringValue = "Transmission is connected. Continue to choose your folder." }
        default:
            heading.stringValue = "Choose where files live"
            subtitle.stringValue = "Step 2 of 2 · Use a local folder that Transmission can access."
            directoryLabel.stringValue = selectedDirectory.path
            directoryLabel.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            content.addArrangedSubview(directoryLabel)
            let choose = NSButton(title: "Choose existing folder…", target: self, action: #selector(chooseDirectory))
            let useDefault = NSButton(title: "Use Downloads/Seme", target: self, action: #selector(useDefaultDirectory))
            content.addArrangedSubview(NSStackView(views: [choose, useDefault]))
            addText(createDefaultDirectory
                    ? "Clicking Finish setup creates Downloads/Seme if needed. Sème will use this folder for new downloads."
                    : "Sème will use the selected folder for new downloads. Existing files are kept.")
            addField("Torrentio URL (optional custom configuration)", field: torrentio)
            addText("Leave the default URL to use public Torrentio discovery. Paste a configured Torrentio URL here if you already have one. No separate Torrentio installation is required.")
            let test = NSButton(title: "Test Torrentio", target: self, action: #selector(testTorrentio))
            content.addArrangedSubview(test)
            addText("This setup downloads the selected video file, keeps downloads for seeding, and disables automatic torrent removal and file deletion. You can change these settings later.")
        }
    }

    private func addText(_ text: String, bold: Bool = false) {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: bold ? .semibold : .regular)
        label.maximumNumberOfLines = 0
        content.addArrangedSubview(label)
        label.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
    }

    private func addField(_ label: String, field: NSTextField) {
        let title = NSTextField(labelWithString: label)
        title.font = .systemFont(ofSize: 12, weight: .medium)
        let group = NSStackView(views: [title, field])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = 5
        content.addArrangedSubview(group)
        group.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        field.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        field.lineBreakMode = .byTruncatingMiddle
    }

    func controlTextDidChange(_ obj: Notification) {
        testedConnection = nil
        if step == 1 { next.isEnabled = false; status.stringValue = "Test this connection before continuing." }
    }

    private func connectionValues() -> [String: String] {
        ["url": address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
         "username": username.stringValue, "password": password.stringValue,
         "label": (config["transmission"] as? [String: Any])?["label"] as? String ?? "seme",
         "download_dir": selectedDirectory.path]
    }

    @objc private func previousStep() { guard !busy else { return }; step = max(0, step - 1); render() }
    @objc private func nextStep() {
        guard !busy else { return }
        if step < 2 {
            if step == 1 && testedConnection != connectionValues() { return }
            step += 1
            render()
        } else { save() }
    }

    @objc private func testConnection() {
        guard !busy else { return }
        let values = connectionValues()
        guard let url = URL(string: values["url"] ?? ""), ["http", "https"].contains(url.scheme ?? ""),
              ["127.0.0.1", "localhost", "::1"].contains(url.host ?? ""), url.user == nil, url.password == nil else {
            showStatus("Enter a local Transmission HTTP RPC address, such as http://127.0.0.1:9091/transmission/rpc.", error: true)
            return
        }
        setBusy(true, message: "Checking Transmission…")
        Task {
            do {
                let result = try await api.request("POST", "/api/config/test-transmission", body: values)
                if result["ok"] as? Bool == true {
                    testedConnection = values
                    setBusy(false)
                    next.isEnabled = true
                    let version = result["version"] as? String ?? ""
                    showStatus("Connected to Transmission\(version.isEmpty ? "" : " " + version). RPC is ready for Sème.")
                } else {
                    setBusy(false)
                    next.isEnabled = false
                    showStatus("Cannot connect. Open Transmission, enable remote access in Settings → Remote, and check the port and credentials. Keep 127.0.0.1 in the allowed addresses.", error: true)
                }
            } catch {
                setBusy(false)
                next.isEnabled = false
                showStatus(error.localizedDescription, error: true)
            }
        }
    }

    @objc private func testTorrentio() {
        guard !busy else { return }
        setBusy(true, message: "Checking Torrentio…")
        Task {
            do {
                let result = try await api.request("POST", "/api/config/test-torrentio", body: ["url": torrentioURL()])
                setBusy(false)
                showStatus(result["ok"] as? Bool == true ? "Torrentio is available." : "Torrentio could not be reached. Check the URL and your internet connection.", error: result["ok"] as? Bool != true)
            } catch { setBusy(false); showStatus(error.localizedDescription, error: true) }
        }
    }

    @objc private func chooseDirectory() {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose a folder for Sème downloads"
        panel.prompt = "Use this folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.directoryURL = selectedDirectory.deletingLastPathComponent()
        guard let window else { return }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self, let url = panel.url else { return }
            self.selectedDirectory = url.standardizedFileURL
            self.createDefaultDirectory = false
            self.render()
        }
    }

    @objc private func useDefaultDirectory() {
        guard !busy else { return }
        selectedDirectory = defaultDirectory
        createDefaultDirectory = true
        render()
    }

    private func torrentioURL() -> String {
        let value = torrentio.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "https://torrentio.strem.fun" : value
    }

    private func save() {
        guard let url = URL(string: torrentioURL()), ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
              url.user == nil, url.password == nil else {
            showStatus("Enter a valid Torrentio HTTP or HTTPS URL.", error: true)
            return
        }
        do {
            if createDefaultDirectory {
                try FileManager.default.createDirectory(at: selectedDirectory, withIntermediateDirectories: true)
            }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: selectedDirectory.path, isDirectory: &isDirectory),
                  isDirectory.boolValue, FileManager.default.isWritableFile(atPath: selectedDirectory.path) else {
                throw DesktopError.message("Choose an existing folder that your Mac can write to.")
            }
        } catch { showStatus(error.localizedDescription, error: true); return }
        setBusy(true, message: "Saving your setup…")
        Task {
            do {
                // Fetch the complete current DTO to preserve settings changed elsewhere during setup.
                var current = try await api.request("GET", "/api/config")
                var transmission = current["transmission"] as? [String: Any] ?? [:]
                connectionValues().forEach { transmission[$0.key] = $0.value }
                current["transmission"] = transmission
                setValue("type", "transmission", in: "downloader", of: &current)
                setValue("full", false, in: "seeding", of: &current)
                setValue("keep_forever", true, in: "cleanup", of: &current)
                setValue("delete_files_on_remove", false, in: "storage", of: &current)
                setValue("enabled", true, in: "torrentio", of: &current)
                setValue("url", torrentioURL(), in: "torrentio", of: &current)
                setValue("setup_complete", true, in: "desktop", of: &current)
                var paths = current["paths"] as? [String: Any] ?? [:]
                var mappings = paths["mappings"] as? [[String: Any]] ?? []
                let path = selectedDirectory.path
                // The first local root controls disk accounting. Prefer the chosen
                // identity mapping while preserving every distinct existing mapping.
                mappings.removeAll(where: { ($0["Remote"] as? String ?? $0["remote"] as? String) == path && ($0["Local"] as? String ?? $0["local"] as? String) == path })
                mappings.insert(["Remote": path, "Local": path], at: 0)
                paths["mappings"] = mappings
                current["paths"] = paths
                _ = try await api.request("PUT", "/api/config", body: current)
                setBusy(false)
                window?.orderOut(nil)
                finished()
            } catch { setBusy(false); showStatus(error.localizedDescription, error: true) }
        }
    }

    private func setValue(_ key: String, _ value: Any, in section: String, of config: inout [String: Any]) {
        var object = config[section] as? [String: Any] ?? [:]
        object[key] = value
        config[section] = object
    }

    private func setBusy(_ value: Bool, message: String = "") {
        busy = value
        back.isEnabled = !value
        next.isEnabled = !value && (step != 1 || testedConnection == connectionValues())
        content.subviews.forEach { setControlsEnabled($0, enabled: !value) }
        if !message.isEmpty { showStatus(message) }
    }

    private func setControlsEnabled(_ view: NSView, enabled: Bool) {
        (view as? NSControl)?.isEnabled = enabled
        view.subviews.forEach { setControlsEnabled($0, enabled: enabled) }
    }

    private func showStatus(_ message: String, error: Bool = false) {
        status.textColor = error ? .systemRed : .secondaryLabelColor
        status.stringValue = message
    }

    private func transmissionURL() -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: "org.m0k.transmission")
            ?? (FileManager.default.fileExists(atPath: "/Applications/Transmission.app") ? URL(fileURLWithPath: "/Applications/Transmission.app") : nil)
    }

    @objc private func openTransmission() {
        if let url = transmissionURL() {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        } else if let url = URL(string: "https://transmissionbt.com/download") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Offline visual QA seam; it renders this app's own view without interacting with other apps.
    func writeScreenshot(to url: URL, step screenshotStep: Int = 0) throws {
        step = min(2, max(0, screenshotStep))
        render()
        guard let view = window?.contentView else { return }
        view.layoutSubtreeIfNeeded()
        window?.display()
        // PDF rendering includes modern AppKit controls whose backing layers
        // may be omitted by cacheDisplay(in:to:).
        let pdfData = view.dataWithPDF(inside: view.bounds)
        guard let provider = CGDataProvider(data: pdfData as CFData),
              let document = CGPDFDocument(provider), let page = document.page(at: 1),
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
                    pixelsWide: Int(view.bounds.width * 2), pixelsHigh: Int(view.bounds.height * 2),
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap)?.cgContext else {
            throw DesktopError.message("Could not render the setup window.")
        }
        context.scaleBy(x: 2, y: 2)
        context.setFillColor(NSColor.windowBackgroundColor.cgColor)
        context.fill(view.bounds)
        context.drawPDFPage(page)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
        try png.write(to: url)
    }
}

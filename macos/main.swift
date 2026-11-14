import AppKit
import WebKit
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private let server = ServerController()
    private var api: DesktopAPI?
    private var statusItem: NSStatusItem?
    private var loginItem: NSMenuItem?
    private var dashboard: NSWindow?
    private var setup: SetupWindow?
    private var webView: WKWebView?
    private var configured = false
    private var terminating = false
    private var launchedAtLogin = false
    private var startupComplete = false
    private var dashboardBuilding = false
    private var smokeVerified = false
    private let smoke = CommandLine.arguments.contains("--smoke-test")
    var exitCode: Int32 = 0

    func applicationWillFinishLaunching(_ notification: Notification) {
        if let event = NSAppleEventManager.shared().currentAppleEvent {
            launchedAtLogin = event.eventID == kAEOpenApplication &&
                event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenus()
        Task { await start() }
    }

    private func start() async {
        do {
            if smoke && (ProcessInfo.processInfo.environment["SEME_DESKTOP_DATA_DIR"] ?? "").isEmpty {
                throw DesktopError.message("Smoke testing requires an isolated SEME_DESKTOP_DATA_DIR.")
            }
            let client = try await server.start()
            api = client
            let config = try await client.request("GET", "/api/config")
            if terminating { return }
            configured = (config["desktop"] as? [String: Any])?["setup_complete"] as? Bool == true
            startupComplete = true
            server.unexpectedExit = { [weak self] in self?.serverExited() }
            if smoke {
                let info = try await client.request("GET", "/api/session")
                guard info["authenticated"] as? Bool == true else {
                    throw DesktopError.message("Smoke authentication failed.")
                }
                if let path = ProcessInfo.processInfo.environment["SEME_DESKTOP_SCREENSHOT"], !path.isEmpty {
                    let wizard = SetupWindow(api: client, config: config, finished: {})
                    setup = wizard
                    wizard.showWindow(nil)
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    let step = Int(ProcessInfo.processInfo.environment["SEME_DESKTOP_SCREENSHOT_STEP"] ?? "0") ?? 0
                    try wizard.writeScreenshot(to: URL(fileURLWithPath: path), step: step)
                }
                try await verifyEmbeddedDashboard()
                smokeVerified = true
                requestTermination()
                return
            }
            if configured {
                if !launchedAtLogin { await showDashboard() }
            } else {
                showSetup(config: config)
            }
        } catch DesktopError.alreadyRunning {
            if terminating { return }
            if let id = Bundle.main.bundleIdentifier {
                NSRunningApplication.runningApplications(withBundleIdentifier: id)
                    .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier })?
                    .activate(options: [.activateAllWindows])
            }
            if smoke { await finishSmoke(error: DesktopError.alreadyRunning) }
            requestTermination()
        } catch {
            if terminating { return }
            if smoke {
                await finishSmoke(error: error)
            } else {
                let alert = NSAlert()
                alert.messageText = "Sème could not start"
                alert.informativeText = error.localizedDescription + "\n\nYou can find diagnostic details in the application data folder."
                alert.addButton(withTitle: "Quit")
                alert.addButton(withTitle: "Open diagnostic folder")
                NSApp.activate(ignoringOtherApps: true)
                if alert.runModal() == .alertSecondButtonReturn {
                    NSWorkspace.shared.open(server.dataDirectory)
                }
            }
            requestTermination()
        }
    }

    private func finishSmoke(error: Error) async -> Never {
        await server.stop()
        print("SEME_SMOKE_FAILED: \(error.localizedDescription)")
        exit(1)
    }

    // Termination can run a nested AppKit event loop. Leave the Swift actor job
    // before entering it so the asynchronous server shutdown can make progress.
    private func requestTermination() {
        RunLoop.main.perform { NSApp.terminate(nil) }
    }

    private func buildMenus() {
        let main = NSMenu()
        let appRoot = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(item("About Sème", action: #selector(about)))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Open Sème", action: #selector(openApp), key: "o"))
        appMenu.addItem(item("Set up Sème…", action: #selector(openSetup)))
        appMenu.addItem(item("Install in Stremio", action: #selector(installInStremio)))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Hide Sème", action: #selector(hideApp), key: "h"))
        appMenu.addItem(item("Quit Sème", action: #selector(quitApp), key: "q"))
        appRoot.submenu = appMenu
        main.addItem(appRoot)
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(NSMenuItem(title: title, action: NSSelectorFromString(action), keyEquivalent: key))
        }
        edit.submenu = editMenu
        main.addItem(edit)
        NSApp.mainMenu = main

        let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = status.button {
            let image = NSImage(named: NSImage.Name("Seme")) ?? Bundle.main.url(forResource: "Seme", withExtension: "icns").flatMap(NSImage.init(contentsOf:))
            image?.size = NSSize(width: 20, height: 20)
            button.image = image ?? NSImage(systemSymbolName: "leaf.fill", accessibilityDescription: "Sème")
            button.toolTip = "Sème · Transmission keeps seeding independently"
            button.setAccessibilityLabel("Sème")
        }
        let menu = NSMenu()
        menu.addItem(item("Open Sème", action: #selector(openApp)))
        menu.addItem(item("Set up Sème…", action: #selector(openSetup)))
        menu.addItem(item("Install in Stremio", action: #selector(installInStremio)))
        menu.addItem(.separator())
        let login = item("Launch at login", action: #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        loginItem = login
        menu.addItem(item("Open diagnostic folder", action: #selector(openDiagnostics)))
        menu.addItem(.separator())
        let note = NSMenuItem(title: "Transmission seeds independently", action: nil, keyEquivalent: "")
        note.isEnabled = false
        menu.addItem(note)
        menu.addItem(item("Quit Sème", action: #selector(quitApp), key: "q"))
        status.menu = menu
        statusItem = status
    }

    private func item(_ title: String, action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func openApp() {
        guard startupComplete else { return }
        if configured { Task { await showDashboard() } }
        else { openSetup() }
    }

    @objc private func openSetup() {
        guard let api else { return }
        if let setup { setup.showWindow(nil); NSApp.activate(ignoringOtherApps: true); return }
        Task {
            do { showSetup(config: try await api.request("GET", "/api/config")) }
            catch { showError("Could not open setup", error.localizedDescription) }
        }
    }

    private func showSetup(config: [String: Any]) {
        guard let api else { return }
        let wizard = SetupWindow(api: api, config: config) { [weak self] in
            guard let self else { return }
            self.configured = true
            self.setup = nil
            Task { await self.showDashboard() }
        }
        setup = wizard
        wizard.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showDashboard() async {
        guard let api else { return }
        if let dashboard {
            dashboard.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        guard !dashboardBuilding else { return }
        dashboardBuilding = true
        defer { dashboardBuilding = false }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let browser = WKWebView(frame: .zero, configuration: configuration)
        browser.navigationDelegate = self
        browser.uiDelegate = self
        browser.allowsBackForwardNavigationGestures = true
        for cookie in api.cookies {
            await withCheckedContinuation { continuation in
                configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { continuation.resume() }
            }
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1160, height: 780),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Sème"
        window.minSize = NSSize(width: 800, height: 600)
        window.isReleasedWhenClosed = false
        let title = NSTextField(labelWithString: "Sème is available in your menu bar")
        title.textColor = .secondaryLabelColor
        title.font = .systemFont(ofSize: 12)
        let install = NSButton(title: "Install in Stremio", target: self, action: #selector(installInStremio))
        let setupButton = NSButton(title: "Setup…", target: self, action: #selector(openSetup))
        let header = NSStackView(views: [title, NSView(), setupButton, install])
        header.spacing = 12
        header.edgeInsets = NSEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
        let stack = NSStackView(views: [header, browser])
        stack.orientation = .vertical
        stack.spacing = 0
        stack.alignment = .leading
        window.contentView = stack
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        browser.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        browser.heightAnchor.constraint(greaterThanOrEqualToConstant: 500).isActive = true
        webView = browser
        dashboard = window
        browser.load(URLRequest(url: api.baseURL))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Exercise the real cookie handoff and React shell using only read-only requests.
    private func verifyEmbeddedDashboard() async throws {
        await showDashboard()
        guard let browser = webView, let base = api?.baseURL else {
            throw DesktopError.message("Smoke dashboard could not be created.")
        }
        let deadline = Date().addingTimeInterval(10)
        let script = """
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        try {
          const response = await fetch('/api/session', {signal: controller.signal});
          const session = await response.json();
          return {
            authenticated: response.ok && session.authenticated === true,
            dashboard: Array.from(document.querySelectorAll('h1')).some(node => node.textContent.trim() === 'Dashboard'),
            login: document.querySelector('input[type="password"]') !== null
          };
        } finally { clearTimeout(timeout); }
        """
        while Date() < deadline {
            if !browser.isLoading, let url = browser.url,
               url.scheme == base.scheme, url.host == base.host, url.port == base.port,
               let result = try? await browser.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page),
               let state = result as? [String: Any],
               state["authenticated"] as? Bool == true,
               state["dashboard"] as? Bool == true,
               state["login"] as? Bool == false {
                if let path = ProcessInfo.processInfo.environment["SEME_DESKTOP_DASHBOARD_SCREENSHOT"], !path.isEmpty {
                    let image = try await browser.takeSnapshot(configuration: nil)
                    guard let tiff = image.tiffRepresentation,
                          let bitmap = NSBitmapImageRep(data: tiff),
                          let png = bitmap.representation(using: .png, properties: [:]) else {
                        throw DesktopError.message("Smoke dashboard snapshot could not be encoded.")
                    }
                    try png.write(to: URL(fileURLWithPath: path))
                }
                return
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw DesktopError.message("Smoke dashboard did not render an authenticated Dashboard within 10 seconds.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let base = api?.baseURL else { decisionHandler(.cancel); return }
        if url.scheme == base.scheme && url.host == base.host && url.port == base.port {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if url.scheme == "stremio" { installInStremio() }
            else if navigationAction.navigationType == .linkActivated && ["http", "https"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if url.scheme == "stremio" { installInStremio() }
            else if let base = api?.baseURL, url.scheme == base.scheme && url.host == base.host && url.port == base.port {
                webView.load(navigationAction.request)
            } else if ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    @objc private func installInStremio() {
        guard startupComplete else { return }
        guard configured else { openSetup(); return }
        guard let url = URL(string: "stremio://127.0.0.1:17880/stremio/manifest.json") else { return }
        guard NSWorkspace.shared.urlForApplication(toOpen: url) != nil else {
            let alert = NSAlert()
            alert.messageText = "Install Stremio to continue"
            alert.informativeText = "Download and open the Stremio desktop app, then click Install in Stremio again. Keep Sème running whenever you use the addon."
            alert.addButton(withTitle: "Get Stremio")
            alert.addButton(withTitle: "Copy addon URL")
            alert.addButton(withTitle: "Cancel")
            let result = alert.runModal()
            if result == .alertFirstButtonReturn { NSWorkspace.shared.open(URL(string: "https://www.stremio.com/downloads")!) }
            if result == .alertSecondButtonReturn {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString("http://127.0.0.1:17880/stremio/manifest.json", forType: .string)
            }
            return
        }
        NSWorkspace.shared.open(url)
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
            loginItem?.state = SMAppService.mainApp.status == .enabled ? .on : .off
            if SMAppService.mainApp.status == .requiresApproval {
                showError("Allow Sème at login", "Approve Sème in System Settings → General → Login Items to finish enabling launch at login.")
                SMAppService.openSystemSettingsLoginItems()
            }
        } catch { showError("Could not change launch at login", error.localizedDescription) }
    }

    @objc private func about() { NSApp.orderFrontStandardAboutPanel(nil) }
    @objc private func hideApp() { NSApp.hide(nil) }
    @objc private func quitApp() { requestTermination() }
    @objc private func openDiagnostics() { NSWorkspace.shared.open(server.dataDirectory) }

    private func showError(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func serverExited() {
        guard !terminating else { return }
        showError("Sème’s local server stopped", "Reopen Sème to reconnect. Diagnostic details are in ~/Library/Application Support/Seme/seme.log. Transmission continues running and seeding independently.")
        requestTermination()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openApp()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        terminating = true
        Task {
            await server.stop()
            if smoke {
                guard smokeVerified, server.process?.isRunning != true else {
                    print("SEME_SMOKE_FAILED: normal Quit did not stop the owned server")
                    exit(1)
                }
                print("SEME_SMOKE_OK: native and WebKit sessions authenticated, dashboard rendered, normal Quit stopped owned server")
                fflush(stdout)
            }
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
    exit(delegate.exitCode)
}

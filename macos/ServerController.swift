import AppKit
import Foundation
import Darwin

enum DesktopError: LocalizedError {
    case message(String)
    case alreadyRunning

    var errorDescription: String? {
        switch self {
        case .message(let message): return message
        case .alreadyRunning: return "Sème is already running. Use its menu bar icon to open it."
        }
    }
}

private struct ReadyMessage: Decodable {
    let url: String
    let admin_password: String
}

/// Owns exactly the child it starts; never connects to or terminates an existing listener.
@MainActor
final class ServerController {
    private(set) var process: Process?
    private var runtimeDirectory: URL?
    private var lockDescriptor: Int32 = -1
    private var inputPipe: Pipe?
    private(set) var stopping = false
    var unexpectedExit: (() -> Void)?

    var dataDirectory: URL {
        if let value = ProcessInfo.processInfo.environment["SEME_DESKTOP_DATA_DIR"], !value.isEmpty {
            return URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Seme", isDirectory: true)
    }

    func start() async throws -> DesktopAPI {
        let fm = FileManager.default
        try fm.createDirectory(at: dataDirectory, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        let lockPath = dataDirectory.appendingPathComponent("desktop-launch.lock").path
        lockDescriptor = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard lockDescriptor >= 0 else {
            throw DesktopError.message("Sème cannot access its application data folder. Check its permissions and try again.")
        }
        guard flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(lockDescriptor)
            lockDescriptor = -1
            throw DesktopError.alreadyRunning
        }
        let runtime = fm.temporaryDirectory.appendingPathComponent("seme-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: runtime, withIntermediateDirectories: false,
                               attributes: [.posixPermissions: 0o700])
        runtimeDirectory = runtime
        let ready = runtime.appendingPathComponent("ready.json")
        guard let resources = Bundle.main.resourceURL else {
            throw DesktopError.message("This copy of Sème is incomplete. Reinstall the app.")
        }
        let executable = resources.appendingPathComponent("seme-server")
        guard fm.isExecutableFile(atPath: executable.path) else {
            throw DesktopError.message("Sème’s bundled server is missing. Reinstall the app.")
        }
        let child = Process()
        child.executableURL = executable
        child.arguments = ["--desktop", "--desktop-data-dir", dataDirectory.path, "--desktop-ready", ready.path]
        child.currentDirectoryURL = dataDirectory
        // The desktop server omits startup secrets; retain a private diagnostic log.
        let logPath = dataDirectory.appendingPathComponent("seme.log").path
        let logDescriptor = open(logPath, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard logDescriptor >= 0 else {
            throw DesktopError.message("Sème cannot open its diagnostic log. Check the permissions of its application data folder.")
        }
        fchmod(logDescriptor, 0o600)
        let log = FileHandle(fileDescriptor: logDescriptor, closeOnDealloc: true)
        child.standardOutput = log
        child.standardError = log
        let pipe = Pipe()
        inputPipe = pipe
        child.standardInput = pipe
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.stopping else { return }
                self.unexpectedExit?()
            }
        }
        try child.run()
        process = child
        // A ready file proves this child bound the port, so a stale/unrelated listener is never adopted.
        for _ in 0..<200 {
            guard child.isRunning else {
                throw DesktopError.message("Sème could not start its local server. Port 17880 may already be in use. Quit the other Sème or server using that port, then reopen Sème.")
            }
            if fm.fileExists(atPath: ready.path) {
                let attributes = try fm.attributesOfItem(atPath: ready.path)
                guard attributes[.type] as? FileAttributeType == .typeRegular,
                      ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) < 65536 else {
                    throw DesktopError.message("Sème received an invalid startup response. Reopen the app.")
                }
                let message = try JSONDecoder().decode(ReadyMessage.self, from: Data(contentsOf: ready))
                try? fm.removeItem(at: ready)
                guard let url = URL(string: message.url), url.scheme == "http", url.host == "127.0.0.1",
                      url.port == 17880, url.user == nil, url.password == nil,
                      url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
                      !message.admin_password.isEmpty else {
                    throw DesktopError.message("Sème received an invalid local server address. Reopen the app.")
                }
                let api = DesktopAPI(baseURL: url)
                try await api.authenticate(password: message.admin_password)
                return api
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw DesktopError.message("Sème’s local server did not become ready within 20 seconds. Reopen the app and check that port 17880 is available.")
    }

    func stop() async {
        stopping = true
        if let child = process, child.isRunning {
            child.terminate()
            for _ in 0..<30 {
                if !child.isRunning { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            if child.isRunning {
                // Only our retained, still-running Process may be killed.
                kill(child.processIdentifier, SIGKILL)
                for _ in 0..<20 {
                    if !child.isRunning { break }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
        }
        inputPipe = nil
        if let runtimeDirectory { try? FileManager.default.removeItem(at: runtimeDirectory) }
        runtimeDirectory = nil
        if lockDescriptor >= 0 {
            flock(lockDescriptor, LOCK_UN)
            close(lockDescriptor)
            lockDescriptor = -1
        }
    }
}

/// An ephemeral cookie session, shared with the embedded dashboard after login.
final class DesktopAPI: NSObject, URLSessionTaskDelegate {
    let baseURL: URL
    private(set) var cookies: [HTTPCookie] = []
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.httpCookieAcceptPolicy = .always
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(baseURL: URL) { self.baseURL = baseURL }

    func authenticate(password: String) async throws {
        _ = try await request("POST", "/api/session", body: ["password": password])
        cookies = session.configuration.httpCookieStorage?.cookies(for: baseURL) ?? []
        guard !cookies.isEmpty else {
            throw DesktopError.message("Sème could not establish its local admin session. Reopen the app.")
        }
    }

    func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port else {
            throw DesktopError.message("Invalid local API address.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("XMLHttpRequest", forHTTPHeaderField: "X-Requested-With")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw DesktopError.message("The local server did not respond.")
        }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(response.statusCode) else {
            // Do not include raw request/response bodies: they may contain credentials.
            throw DesktopError.message("The local server rejected this request (HTTP \(response.statusCode)). Check the settings and try again.")
        }
        return object
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Credentials and session cookies never follow redirects away from the local server.
        completionHandler(nil)
    }
}

import Foundation

/// Navigate to the addons page with the original transport URL. A host-style
/// manifest link makes Stremio force HTTPS (and older versions drop its port).
func stremioInstallationURL(for manifest: URL) -> URL? {
    var components = URLComponents()
    components.scheme = "stremio"
    components.host = ""
    components.path = "/addons"
    // URLSearchParams in Stremio treats a literal '+' as a space. Escape it too.
    let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    guard let encoded = manifest.absoluteString.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
    components.percentEncodedQuery = "addon=" + encoded
    return components.url
}

import Foundation

@main
struct StremioLinkTests {
    static func main() {
        let manifests = [
            "http://127.0.0.1:17880/stremio/manifest.json",
            "https://example.org:8443/custom/manifest.json?token=a+b&value=a%2Bb"
        ]
        for manifest in manifests {
            guard let link = stremioInstallationURL(for: URL(string: manifest)!),
                  let components = URLComponents(url: link, resolvingAgainstBaseURL: false) else {
                fatalError("Could not build installation link")
            }
            precondition(components.scheme == "stremio")
            precondition(components.host == "")
            precondition(components.path == "/addons")
            precondition(components.queryItems?.count == 1)
            precondition(components.queryItems?.first?.name == "addon")
            precondition(components.queryItems?.first?.value == manifest)
            precondition(!(components.percentEncodedQuery ?? "").contains("+"))
        }
        print("PASS Stremio links preserve HTTP, port and query values")
    }
}

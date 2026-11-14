// Host-style manifest links are rewritten to HTTPS by Stremio, and older
// versions also drop the port. The addons route keeps the full transport URL.
export function stremioInstallURL(manifestURL: string): string {
  return `stremio:///addons?addon=${encodeURIComponent(manifestURL)}`;
}

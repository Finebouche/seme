import { describe, expect, it } from "vitest";
import { stremioInstallURL } from "./stremio";

describe("Stremio installation route", () => {
  it.each([
    "http://127.0.0.1:17880/stremio/manifest.json",
    "https://example.org:8443/custom/manifest.json?token=a+b&value=a%2Bb&lang=fr",
  ])("preserves the complete transport URL: %s", (manifest) => {
    const link = new URL(stremioInstallURL(manifest));
    // Stremio's shell uses an empty host to navigate directly to this page.
    expect(link.protocol).toBe("stremio:");
    expect(link.host).toBe("");
    expect(link.pathname).toBe("/addons");
    expect(link.searchParams.get("addon")).toBe(manifest);
    expect([...link.searchParams.keys()]).toEqual(["addon"]);
  });
});

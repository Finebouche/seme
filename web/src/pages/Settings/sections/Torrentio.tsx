import { useState } from "react";
import { api } from "../../../api";
import { SectionProps } from "../types";
import { SectionCard, TextField, NumberField, ToggleField } from "../fields";

export function Torrentio({ config, update }: SectionProps) {
  const [result, setResult] = useState("");
  async function test() {
    setResult("…");
    try {
      const res = await api.testTorrentio(config.torrentio.url);
      setResult(res.ok ? "✓ Connected" : `✗ ${res.error}`);
    } catch (err) { setResult(`✗ ${(err as Error).message}`); }
  }
  return (
    <SectionCard title="Torrentio" description="Search public torrents through Torrentio. Enabled by default; no Prowlarr instance is needed. Keep at least one search provider configured.">
      <ToggleField label="Enable Torrentio" checked={config.torrentio.enabled} onChange={(v) => update((c) => (c.torrentio.enabled = v))} />
      <TextField label="Torrentio URL" placeholder="https://torrentio.strem.fun" value={config.torrentio.url} onChange={(v) => update((c) => (c.torrentio.url = v))} />
      <NumberField label="Request timeout (seconds)" min={1} value={config.torrentio.timeout_seconds} onChange={(v) => update((c) => (c.torrentio.timeout_seconds = v))} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-outline" onClick={test}>Test connection</button>
        {result && <span className="text-sm">{result}</span>}
      </div>
    </SectionCard>
  );
}

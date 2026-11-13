import { useState } from "react";
import { FolderPicker } from "../../../components/FolderPicker";
import { SectionProps } from "../types";
import { SectionCard } from "../fields";

export function PathMappings({ config, update }: SectionProps) {
  const [pickingIndex, setPickingIndex] = useState<number | null>(null);
  return (
    <SectionCard
      title="Path mappings"
      description={
        <>
          Translate paths as the download client sees them to paths Sème can read (e.g.
          Docker volume mounts: client <code>/downloads</code> → Sème <code>/data</code>).
        </>
      }
    >
      {config.paths.mappings.map((m, i) => (
        <div className="flex items-end gap-2" key={i}>
          <label className="flex flex-1 flex-col gap-1">
            <span className="label-text mb-1">Remote path</span>
            <input
              className="input input-bordered w-full"
              value={m.remote}
              onChange={(e) => update((c) => (c.paths.mappings[i].remote = e.target.value))}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="label-text mb-1">Local path</span>
            <input
              className="input input-bordered w-full"
              value={m.local}
              onChange={(e) => update((c) => (c.paths.mappings[i].local = e.target.value))}
            />
          </label>
          <button type="button" className="btn btn-outline" onClick={() => setPickingIndex(i)}>Browse…</button>
          <button
            type="button"
            className="btn btn-outline btn-error"
            aria-label="Remove mapping"
            onClick={() => update((c) => c.paths.mappings.splice(i, 1))}
          >
            ✕
          </button>
        </div>
      ))}
      {pickingIndex !== null && <FolderPicker initialPath={config.paths.mappings[pickingIndex]?.local} onCancel={() => setPickingIndex(null)} onChoose={(path) => {
        update((c) => { if (c.paths.mappings[pickingIndex]) c.paths.mappings[pickingIndex].local = path; });
        setPickingIndex(null);
      }} />}
      <div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => update((c) => c.paths.mappings.push({ remote: "", local: "" }))}
        >
          + Add mapping
        </button>
      </div>
    </SectionCard>
  );
}

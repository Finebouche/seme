import { useEffect, useRef, useState } from "react";
import { api, DirectoryListing } from "../api";

interface FolderPickerProps {
  initialPath?: string;
  onChoose: (path: string) => void;
  onCancel: () => void;
}

// Browsing only changes local dialog state; choosing commits one existing path.
export function FolderPicker({ initialPath = "", onChoose, onCancel }: FolderPickerProps) {
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [requestedPath, setRequestedPath] = useState(initialPath);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setPath(requestedPath);
    api.directories(requestedPath).then((result) => {
      if (active) { setListing(result); setPath(result.path); }
    }).catch((err: Error) => {
      if (active) { setListing(null); setError(err.message); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [requestedPath]);

  return (
    <dialog ref={dialog} className="modal" aria-labelledby="folder-picker-title" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <div className="modal-box surface">
        <h3 id="folder-picker-title" className="text-lg font-bold">Choose a local folder</h3>
        <p className="mt-2 text-sm opacity-70">Browse folders on Sème’s computer. A remote torrent client may use a different path.</p>
        <div className="my-4 flex gap-2">
          <input autoFocus className="input input-bordered min-w-0 flex-1" aria-label="Folder path" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); setRequestedPath(path); }
          }} />
          <button type="button" className="btn btn-outline" disabled={loading} onClick={() => setRequestedPath(path)}>Open</button>
        </div>
        <button type="button" className="btn btn-outline btn-sm" disabled={loading} onClick={() => setRequestedPath("")}>Home folder</button>
        {loading && <p role="status" className="py-4">Loading folders…</p>}
        {error && <p role="alert" className="my-3 text-error">{error}{error.includes("access denied") && ". Grant Sème access in your system privacy settings, or choose another folder."}</p>}
        {!loading && listing && <>
          <p className="mb-2 break-all text-sm font-medium">{listing.path}</p>
          <button type="button" className="btn btn-outline btn-sm mb-2" disabled={!listing.parent} onClick={() => setRequestedPath(listing.parent)}>↑ Parent folder</button>
          <div className="max-h-64 overflow-y-auto rounded-box border border-base-content/10">
            {listing.directories.map((dir) => <button type="button" key={dir.path} className="block w-full break-all px-3 py-2 text-left hover:bg-base-200" onClick={() => setRequestedPath(dir.path)}>📁 {dir.name}</button>)}
            {!listing.directories.length && <p className="p-3 text-sm opacity-60">No subfolders</p>}
          </div>
          {listing.truncated && <p className="mt-2 text-sm opacity-70">This folder is large; only its first 1,000 entries were checked. Enter a subfolder path to open it directly.</p>}
        </>}
        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={loading || !listing} onClick={() => listing && onChoose(listing.path)}>Use this local folder</button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Cancel folder selection" onClick={onCancel} />
    </dialog>
  );
}

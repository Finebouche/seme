// Package transmission implements the downloader interface using Transmission
// RPC. Transmission 4.0+ is required for adding torrents with an atomic label;
// 4.1+ additionally supports sequential downloads and seeking their start piece.
package transmission

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/kipsilabs/seedstrem/internal/downloader"
	"github.com/kipsilabs/seedstrem/internal/metainfo"
)

var _ downloader.Client = (*Client)(nil)

// ErrNotOwned protects preexisting torrents on a shared Transmission daemon.
// A hash alone never authorizes modifying a torrent without our label.
var ErrNotOwned = errors.New("transmission torrent does not carry the configured ownership label")

type session struct {
	Version              string `json:"version"`
	RPCVersion           int    `json:"rpc_version"`
	DownloadDir          string `json:"download_dir"`
	IncompleteDir        string `json:"incomplete_dir"`
	IncompleteDirEnabled bool   `json:"incomplete_dir_enabled"`
	RenamePartialFiles   bool   `json:"rename_partial_files"`
}

func (c *Client) AddMagnet(ctx context.Context, magnet string, opts downloader.AddOptions) error {
	if _, _, err := metainfo.FromMagnet(magnet); err != nil {
		return err
	}
	return c.add(ctx, map[string]any{"filename": magnet}, opts)
}

func (c *Client) AddTorrentFile(ctx context.Context, raw []byte, opts downloader.AddOptions) error {
	if _, _, _, err := metainfo.FromTorrent(raw); err != nil {
		return err
	}
	return c.add(ctx, map[string]any{"metainfo": base64.StdEncoding.EncodeToString(raw)}, opts)
}

func (c *Client) add(ctx context.Context, args map[string]any, opts downloader.AddOptions) error {
	if c.label == "" || strings.Contains(c.label, ",") {
		return errors.New("transmission: a nonempty ownership label without commas is required")
	}
	if opts.Category != "" && opts.Category != c.label {
		return errors.New("transmission: add category must match the configured ownership label")
	}
	v, err := c.capabilities(ctx)
	if err != nil {
		return err
	}
	// 3.0 has torrent-set labels but cannot label the add atomically. Refuse
	// instead of risking adoption of an unrelated duplicate during a race.
	if v < 17 {
		return fmt.Errorf("%w: Transmission 4.0+ is required for safely labelled adds", downloader.ErrNotSupported)
	}
	args["labels"] = []string{c.label}
	args["paused"] = true // establish seeding policy before allowing activity
	if c.downloadDir != "" {
		args["download_dir"] = c.downloadDir
	}
	if v >= 18 {
		args["sequential_download"] = opts.SequentialDownload
	}
	var result struct {
		Added     *torrent `json:"torrent_added"`
		Duplicate *torrent `json:"torrent_duplicate"`
	}
	if err := c.rpc(ctx, "torrent_add", args, &result); err != nil {
		return err
	}
	if result.Duplicate != nil {
		// Never re-label, change limits, start, or otherwise adopt a duplicate.
		_, err := c.owned(ctx, result.Duplicate.Hash)
		return err
	}
	if result.Added == nil || result.Added.Hash == "" {
		return errors.New("transmission: add returned no torrent")
	}
	if err := c.setOwned(ctx, result.Added.Hash, map[string]any{"seed_ratio_mode": 2, "seed_idle_mode": 2}); err != nil {
		return err
	}
	if !opts.Stopped {
		return c.startOwned(ctx, result.Added.Hash)
	}
	return nil
}

var infoFields = []string{"hash_string", "name", "labels", "status", "error", "percent_done", "size_when_done", "left_until_done", "rate_download", "uploaded_ever", "upload_ratio", "download_dir", "seconds_seeding", "added_date", "tracker_stats"}

func (c *Client) get(ctx context.Context, hashes []string, fields []string) ([]torrent, error) {
	v, err := c.capabilities(ctx)
	if err != nil {
		return nil, err
	}
	if v < 16 {
		return nil, fmt.Errorf("%w: Transmission RPC16+ labels are required", downloader.ErrNotSupported)
	}
	args := map[string]any{"fields": fields}
	if hashes != nil {
		args["ids"] = hashes
	}
	var result struct {
		Torrents []torrent `json:"torrents"`
	}
	if err := c.rpc(ctx, "torrent_get", args, &result); err != nil {
		return nil, err
	}
	return result.Torrents, nil
}

func (c *Client) Torrents(ctx context.Context, hashes []string) ([]downloader.TorrentInfo, error) {
	if len(hashes) == 0 {
		return nil, nil
	}
	fields := append([]string(nil), infoFields...)
	v, err := c.capabilities(ctx)
	if err != nil {
		return nil, err
	}
	if v >= 18 {
		fields = append(fields, "sequential_download")
	}
	list, err := c.get(ctx, hashes, fields)
	if err != nil {
		return nil, err
	}
	out := make([]downloader.TorrentInfo, 0, len(list))
	for _, t := range list {
		if t.hasLabel(c.label) {
			out = append(out, t.info())
		}
	}
	return out, nil
}

// Transmission has no server-side label filter. Fetch only the torrent summary
// fields, then apply exact label matching before returning any torrent.
func (c *Client) TorrentsByLabel(ctx context.Context, label string) ([]downloader.TorrentInfo, error) {
	if label == "" {
		return nil, nil
	}
	fields := append([]string(nil), infoFields...)
	v, err := c.capabilities(ctx)
	if err != nil {
		return nil, err
	}
	if v >= 18 {
		fields = append(fields, "sequential_download")
	}
	list, err := c.get(ctx, nil, fields)
	if err != nil {
		return nil, err
	}
	out := make([]downloader.TorrentInfo, 0, len(list))
	for _, t := range list {
		if t.hasLabel(label) {
			out = append(out, t.info())
		}
	}
	return out, nil
}

func (c *Client) Torrent(ctx context.Context, hash string) (downloader.TorrentInfo, error) {
	list, err := c.Torrents(ctx, []string{hash})
	if err != nil {
		return downloader.TorrentInfo{}, err
	}
	for _, t := range list {
		if strings.EqualFold(t.Hash, hash) {
			return t, nil
		}
	}
	return downloader.TorrentInfo{}, downloader.ErrTorrentNotFound
}

func (c *Client) details(ctx context.Context, hash string, fields ...string) (torrent, error) {
	if strings.TrimSpace(hash) == "" {
		return torrent{}, downloader.ErrTorrentNotFound
	}
	fields = append(fields, "hash_string", "labels")
	list, err := c.get(ctx, []string{hash}, fields)
	if err != nil {
		return torrent{}, err
	}
	for _, t := range list {
		if strings.EqualFold(t.Hash, hash) {
			return t, nil
		}
	}
	return torrent{}, downloader.ErrTorrentNotFound
}

func (c *Client) owned(ctx context.Context, hash string, fields ...string) (torrent, error) {
	if c.label == "" {
		return torrent{}, ErrNotOwned
	}
	t, err := c.details(ctx, hash, fields...)
	if err != nil {
		return torrent{}, err
	}
	if !t.hasLabel(c.label) {
		return torrent{}, ErrNotOwned
	}
	return t, nil
}

func (c *Client) Files(ctx context.Context, hash string) ([]downloader.FileInfo, error) {
	t, err := c.owned(ctx, hash, "files", "file_stats")
	if err != nil {
		return nil, err
	}
	return t.files(), nil
}

func (c *Client) Properties(ctx context.Context, hash string) (downloader.Properties, error) {
	t, err := c.owned(ctx, hash, "piece_size", "piece_count", "download_dir")
	if err != nil {
		return downloader.Properties{}, err
	}
	return downloader.Properties{PieceSize: t.PieceSize, PiecesNum: t.PieceCount, SavePath: t.DownloadDir}, nil
}

func (c *Client) PieceStates(ctx context.Context, hash string) ([]downloader.PieceState, error) {
	t, err := c.owned(ctx, hash, "pieces", "piece_count")
	if err != nil {
		return nil, err
	}
	bits, err := base64.StdEncoding.DecodeString(t.Pieces)
	if err != nil {
		return nil, fmt.Errorf("transmission: invalid pieces bitfield: %w", err)
	}
	if t.PieceCount < 0 || int64(t.PieceCount) > int64(len(bits))*8 {
		return nil, errors.New("transmission: truncated pieces bitfield")
	}
	out := make([]downloader.PieceState, t.PieceCount)
	for i := range out {
		if bits[i/8]&(0x80>>uint(i%8)) != 0 {
			out[i] = downloader.PieceHave
		}
	}
	return out, nil
}

func (c *Client) setOwned(ctx context.Context, hash string, args map[string]any) error {
	if _, err := c.owned(ctx, hash); err != nil {
		return err
	}
	args["ids"] = []string{hash}
	return c.rpc(ctx, "torrent_set", args, nil)
}

func (c *Client) SetFilePriority(ctx context.Context, hash string, indices []int, priority int) error {
	if len(indices) == 0 {
		return nil
	} // empty RPC arrays mean ALL files
	if priority < 0 || priority > 7 {
		return errors.New("transmission: file priority must be between 0 and 7")
	}
	t, err := c.owned(ctx, hash, "files")
	if err != nil {
		return err
	}
	for _, idx := range indices {
		if idx < 0 || idx >= len(t.Files) {
			return fmt.Errorf("transmission: file index %d out of range", idx)
		}
	}
	args := map[string]any{"ids": []string{hash}}
	if priority == 0 {
		args["files_unwanted"] = indices
	} else {
		args["files_wanted"] = indices
		key := "priority_normal"
		if priority == 1 {
			key = "priority_low"
		} else if priority >= 6 {
			key = "priority_high"
		}
		args[key] = indices
	}
	return c.rpc(ctx, "torrent_set", args, nil)
}

func (c *Client) SetSequentialDownload(ctx context.Context, hash string, on bool) error {
	v, err := c.capabilities(ctx)
	if err != nil {
		return err
	}
	if v < 18 {
		return downloader.ErrNotSupported
	}
	return c.setOwned(ctx, hash, map[string]any{"sequential_download": on})
}

// The RPC has no independent first/last-piece flag.
func (c *Client) SetFirstLastPiecePrio(context.Context, string, bool) error {
	return downloader.ErrNotSupported
}

// PrioritizePieces moves Transmission 4.1's sequential cursor to first. The
// native picker continues forward from there; it has no bounded window or
// deadline API. Concurrent readers share this single cursor, so this remains
// a best-effort seek hint, not a guarantee of ordered delivery of [first,last].
// A short absolute lease prevents concurrent warm-up head/tail hints from
// overwriting each other. Competitors retry until the active range is complete
// or ten seconds elapse; repeated hints cannot renew that lease indefinitely.
func (c *Client) PrioritizePieces(ctx context.Context, hash string, first, last int) error {
	v, err := c.capabilities(ctx)
	if err != nil {
		return err
	}
	if v < 18 {
		return downloader.ErrNotSupported
	}
	if first < 0 || last < first {
		return fmt.Errorf("%w: invalid piece range", downloader.ErrHintDeclined)
	}
	hint := c.pieceHint(hash)
	if hint == nil {
		return fmt.Errorf("%w: too many active piece hints", downloader.ErrHintDeclined)
	}
	hint.mu.Lock()
	defer hint.mu.Unlock()
	t, err := c.owned(ctx, hash, "piece_count", "pieces")
	if err != nil {
		return err
	}
	if first >= t.PieceCount || last >= t.PieceCount {
		return fmt.Errorf("%w: piece range outside resolved metadata", downloader.ErrHintDeclined)
	}
	bits, err := base64.StdEncoding.DecodeString(t.Pieces)
	if err != nil || int64(t.PieceCount) > int64(len(bits))*8 {
		return fmt.Errorf("%w: piece bitfield not available", downloader.ErrHintDeclined)
	}
	haveRange := func(first, last int) bool {
		for i := first; i <= last; i++ {
			if i >= t.PieceCount || bits[i/8]&(0x80>>uint(i%8)) == 0 {
				return false
			}
		}
		return true
	}
	if haveRange(first, last) {
		return nil
	}
	if !hint.started.IsZero() && time.Since(hint.started) < 10*time.Second && !haveRange(hint.first, hint.last) {
		if first == hint.first && last == hint.last {
			return nil
		}
		return fmt.Errorf("%w: sequential cursor is fetching another requested range", downloader.ErrHintDeclined)
	}
	if err := c.rpc(ctx, "torrent_set", map[string]any{"ids": []string{hash}, "sequential_download": true, "sequential_download_from_piece": first}, nil); err != nil {
		return err
	}
	hint.first, hint.last, hint.started = first, last, time.Now()
	return nil
}

type pieceHint struct {
	mu          sync.Mutex
	first, last int
	started     time.Time
}

func (c *Client) pieceHint(hash string) *pieceHint {
	c.hintMu.Lock()
	defer c.hintMu.Unlock()
	if c.hints == nil {
		c.hints = make(map[string]*pieceHint)
	}
	key := strings.ToLower(hash)
	if hint := c.hints[key]; hint != nil {
		return hint
	}
	// Bound memory even if thousands of unrelated requests arrive. Completed
	// deletes remove their entry; inactive entries can also be reclaimed.
	if len(c.hints) >= 1024 {
		for key, hint := range c.hints {
			if hint.mu.TryLock() {
				if time.Since(hint.started) >= time.Minute {
					delete(c.hints, key)
				}
				hint.mu.Unlock()
			}
		}
		if len(c.hints) >= 1024 {
			return nil
		}
	}
	hint := &pieceHint{}
	c.hints[key] = hint
	return hint
}

func (c *Client) startOwned(ctx context.Context, hash string) error {
	if _, err := c.owned(ctx, hash); err != nil {
		return err
	}
	return c.rpc(ctx, "torrent_start_now", map[string]any{"ids": []string{hash}}, nil)
}

func (c *Client) Start(ctx context.Context, hash string) error {
	// Override global ratio and idle limits only for managed torrents. This
	// also repairs a managed torrent added manually with session defaults.
	if err := c.setOwned(ctx, hash, map[string]any{"seed_ratio_mode": 2, "seed_idle_mode": 2}); err != nil {
		return err
	}
	return c.startOwned(ctx, hash)
}

func (c *Client) Delete(ctx context.Context, hash string, deleteFiles bool) error {
	if _, err := c.owned(ctx, hash); err != nil {
		return err
	}
	if err := c.rpc(ctx, "torrent_remove", map[string]any{"ids": []string{hash}, "delete_local_data": deleteFiles}, nil); err != nil {
		return err
	}
	c.hintMu.Lock()
	delete(c.hints, strings.ToLower(hash))
	c.hintMu.Unlock()
	return nil
}

func (c *Client) IncompleteFileHints(ctx context.Context) (downloader.IncompleteHints, error) {
	var s session
	if err := c.rpc(ctx, "session_get", nil, &s); err != nil {
		return downloader.IncompleteHints{}, err
	}
	h := downloader.IncompleteHints{}
	if s.IncompleteDirEnabled {
		h.TempDir = s.IncompleteDir
	}
	if s.RenamePartialFiles {
		h.IncompleteExt = ".part"
	}
	return h, nil
}

func (c *Client) FreeSpace(ctx context.Context) (int64, error) {
	dir := c.downloadDir
	if dir == "" {
		var s session
		if err := c.rpc(ctx, "session_get", nil, &s); err != nil {
			return 0, err
		}
		dir = s.DownloadDir
	}
	if dir == "" {
		return 0, errors.New("transmission: download directory is unknown")
	}
	var result struct {
		SizeBytes *int64 `json:"size_bytes"`
	}
	if err := c.rpc(ctx, "free_space", map[string]any{"path": dir}, &result); err != nil {
		return 0, err
	}
	if result.SizeBytes == nil || *result.SizeBytes < 0 {
		return 0, errors.New("transmission: free-space response has no valid size")
	}
	return *result.SizeBytes, nil
}

// torrent_file is a path on the daemon's filesystem, not exported metainfo.
// Do not read it locally: the daemon may live on a different host.
func (c *Client) ExportTorrent(ctx context.Context, hash string) ([]byte, error) {
	if _, err := c.owned(ctx, hash); err != nil {
		return nil, err
	}
	return nil, downloader.ErrNotSupported
}

func (c *Client) Version(ctx context.Context) (string, error) {
	if _, err := c.capabilities(ctx); err != nil {
		return "", err
	}
	c.versionMu.Lock()
	defer c.versionMu.Unlock()
	return c.version, nil
}

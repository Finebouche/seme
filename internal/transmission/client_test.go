package transmission

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kipsilabs/seedstrem/internal/downloader"
)

const testHash = "0123456789abcdef0123456789abcdef01234567"

type recordedCall struct {
	Method string
	Args   map[string]any
	Modern bool
}
type fixture struct {
	t         *testing.T
	mu        sync.Mutex
	version   int
	torrents  []map[string]any
	calls     []recordedCall
	duplicate bool
	override  func(recordedCall) (any, bool)
}

func newFixture(t *testing.T, version int) (*fixture, *Client) {
	t.Helper()
	f := &fixture{t: t, version: version, torrents: []map[string]any{managedTorrent()}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, New(srv.URL, "alice", "secret", "seme", "/downloads/seme")
}

func managedTorrent() map[string]any {
	return map[string]any{"hash_string": testHash, "name": "movie", "labels": []string{"seme"}, "piece_count": 10, "piece_size": 16384,
		"pieces": base64.StdEncoding.EncodeToString([]byte{0x81, 0x40}), "download_dir": "/downloads/seme",
		"size_when_done": int64(1000), "left_until_done": int64(250), "percent_done": .75, "status": 4, "error": 0,
		"rate_download": 123, "uploaded_ever": 900, "upload_ratio": 1.2, "seconds_seeding": 42, "added_date": 1700000000,
		"tracker_stats": []any{map[string]any{"seeder_count": 12}, map[string]any{"seeder_count": 12}},
		"files":         []any{map[string]any{"name": "movie/video.mkv", "length": 1000, "bytes_completed": 750}, map[string]any{"name": "movie/info.txt", "length": 100, "bytes_completed": 0}},
		"file_stats":    []any{map[string]any{"wanted": true, "priority": 1, "bytes_completed": 750}, map[string]any{"wanted": false, "priority": 0, "bytes_completed": 0}}}
}

func (f *fixture) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method != http.MethodPost || r.URL.Path != "/transmission/rpc" {
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
	}
	if user, pass, ok := r.BasicAuth(); !ok || user != "alice" || pass != "secret" {
		f.t.Errorf("missing basic authentication")
	}
	var req struct {
		Method    string         `json:"method"`
		Arguments map[string]any `json:"arguments"`
		Params    map[string]any `json:"params"`
		JSONRPC   string         `json:"jsonrpc"`
		ID        int            `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		f.t.Error(err)
		w.WriteHeader(400)
		return
	}
	modern := req.JSONRPC == "2.0"
	args := req.Arguments
	if modern {
		args = req.Params
	} else if args != nil {
		args = normalizeLegacy(args).(map[string]any)
	}
	call := recordedCall{Method: strings.ReplaceAll(req.Method, "-", "_"), Args: args, Modern: modern}
	f.calls = append(f.calls, call)
	var result any
	if f.override != nil {
		var handled bool
		result, handled = f.override(call)
		if handled {
			f.reply(w, call, result)
			return
		}
	}
	switch call.Method {
	case "session_get":
		result = map[string]any{"version": "test-version", "rpc_version": f.version, "download_dir": "/default", "incomplete_dir": "/incomplete", "incomplete_dir_enabled": true, "rename_partial_files": true}
	case "torrent_get":
		list := make([]any, 0)
		for _, tor := range f.torrents {
			match := args["ids"] == nil
			if ids, ok := args["ids"].([]any); ok {
				for _, id := range ids {
					if strings.EqualFold(fmt.Sprint(id), fmt.Sprint(tor["hash_string"])) {
						match = true
					}
				}
			}
			if match {
				list = append(list, tor)
			}
		}
		result = map[string]any{"torrents": list}
	case "torrent_add":
		key := "torrent_added"
		if f.duplicate {
			key = "torrent_duplicate"
		}
		result = map[string]any{key: map[string]any{"hash_string": testHash, "name": "movie", "id": 7}}
	case "free_space":
		result = map[string]any{"size_bytes": int64(9007199254740993)}
	case "torrent_set", "torrent_start_now", "torrent_remove":
		if ids, ok := args["ids"].([]any); !ok || len(ids) != 1 || ids[0] != testHash {
			f.t.Errorf("unsafe mutation IDs: %+v", args)
		}
		result = map[string]any{}
	default:
		f.t.Errorf("unexpected RPC method %s", call.Method)
		result = map[string]any{}
	}
	f.reply(w, call, result)
}

func (f *fixture) reply(w http.ResponseWriter, call recordedCall, result any) {
	w.Header().Set("Content-Type", "application/json")
	if call.Modern {
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "result": result, "id": 1})
	} else {
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "success", "arguments": legacyValue(result, call.Method)})
	}
}

func legacyValue(value any, method string) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			key := legacyKey(k)
			if k == "download_dir" && method == "torrent_get" {
				key = "downloadDir"
			}
			out[key] = legacyValue(item, method)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = legacyValue(item, method)
		}
		return out
	default:
		return v
	}
}

func (f *fixture) mutations() []recordedCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []recordedCall
	for _, call := range f.calls {
		if call.Method != "session_get" && call.Method != "torrent_get" && call.Method != "free_space" {
			out = append(out, call)
		}
	}
	return out
}

func TestHandshakeAndTokenRenewal(t *testing.T) {
	var tokens []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Transmission-Session-Id")
		tokens = append(tokens, token)
		if len(tokens) == 1 || len(tokens) == 3 {
			w.Header().Set("X-Transmission-Session-Id", fmt.Sprintf("token-%d", len(tokens)))
			w.WriteHeader(409)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "success", "arguments": map[string]any{"rpc-version": 17, "version": "4.0.6"}})
	}))
	defer srv.Close()
	c := New(srv.URL, "", "", "seme", "")
	for range 2 {
		var result session
		if err := c.call(context.Background(), "session_get", nil, &result, false); err != nil {
			t.Fatal(err)
		}
	}
	if want := []string{"", "token-1", "token-1", "token-3"}; !reflect.DeepEqual(tokens, want) {
		t.Fatalf("tokens = %v, want %v", tokens, want)
	}
}

func TestRPCErrorsAndCancellation(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
		status           int
		modern           bool
	}{
		{"authentication", "", "HTTP 401", 401, false},
		{"csrf missing token", "", "without session ID", 409, false},
		{"invalid JSON", "<html>", "invalid JSON", 200, false},
		{"legacy error", `{"result":"permission denied","arguments":{}}`, "permission denied", 200, false},
		{"modern error", `{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"},"id":1}`, "RPC error -32602", 200, true},
		{"missing result", `{}`, "missing RPC result", 200, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			c := New(srv.URL, "", "", "seme", "")
			if err := c.call(context.Background(), "session_get", nil, nil, tc.modern); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %s", err, tc.want)
			}
		})
	}
	f, c := newFixture(t, 18)
	_ = f
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Version(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel error = %v", err)
	}
	if _, err := New(":bad", "", "", "seme", "").Version(context.Background()); err == nil {
		t.Fatal("invalid URL accepted")
	}
}

func TestReadConversionsAndLegacyPrecision(t *testing.T) {
	for _, version := range []int{16, 17, 18} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			_, c := newFixture(t, version)
			ctx := context.Background()
			got, err := c.Torrent(ctx, strings.ToUpper(testHash))
			if err != nil {
				t.Fatal(err)
			}
			if got.Hash != testHash || got.State != downloader.StateDownloading || got.Completed != 750 || got.NumSeeds != 12 || got.SavePath != "/downloads/seme" || got.SeedingTime != 42*time.Second || got.AddedAt.Unix() != 1700000000 {
				t.Fatalf("info = %+v", got)
			}
			files, err := c.Files(ctx, testHash)
			if err != nil {
				t.Fatal(err)
			}
			if len(files) != 2 || files[0].Priority != 7 || files[0].Progress != .75 || files[1].Priority != 0 || files[0].Name != "movie/video.mkv" {
				t.Fatalf("files = %+v", files)
			}
			props, err := c.Properties(ctx, testHash)
			if err != nil || props.PieceSize != 16384 || props.PiecesNum != 10 || props.SavePath != "/downloads/seme" {
				t.Fatalf("props = %+v, %v", props, err)
			}
			hints, err := c.IncompleteFileHints(ctx)
			if err != nil || hints.TempDir != "/incomplete" || hints.IncompleteExt != ".part" {
				t.Fatalf("hints = %+v, %v", hints, err)
			}
			space, err := c.FreeSpace(ctx)
			if err != nil || space != 9007199254740993 {
				t.Fatalf("free space = %d, %v", space, err)
			}
			if _, err := c.Torrent(ctx, "unknown"); !errors.Is(err, downloader.ErrTorrentNotFound) {
				t.Fatalf("unknown torrent = %v", err)
			}
			if _, err := c.ExportTorrent(ctx, testHash); !errors.Is(err, downloader.ErrNotSupported) {
				t.Fatalf("export = %v", err)
			}
		})
	}
}

func TestPieceBitfieldMSBAndPadding(t *testing.T) {
	f, c := newFixture(t, 18)
	got, err := c.PieceStates(context.Background(), testHash)
	if err != nil {
		t.Fatal(err)
	}
	want := []downloader.PieceState{2, 0, 0, 0, 0, 0, 0, 2, 0, 2}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("states = %v, want %v", got, want)
	}
	for _, bits := range []string{"!not base64", "gA=="} {
		f.mu.Lock()
		f.torrents[0]["pieces"] = bits
		f.mu.Unlock()
		if _, err := c.PieceStates(context.Background(), testHash); err == nil {
			t.Fatalf("bad bitfield %q accepted", bits)
		}
	}
}

func TestLabelsAndEmptyFilters(t *testing.T) {
	f, c := newFixture(t, 18)
	foreign := managedTorrent()
	foreign["hash_string"] = "foreign"
	foreign["labels"] = []string{"someone-else"}
	f.torrents = append(f.torrents, foreign)
	ctx := context.Background()
	if got, err := c.Torrents(ctx, nil); err != nil || len(got) != 0 {
		t.Fatalf("empty hashes: %+v %v", got, err)
	}
	if got, err := c.TorrentsByLabel(ctx, ""); err != nil || len(got) != 0 {
		t.Fatalf("empty label: %+v %v", got, err)
	}
	if len(f.calls) != 0 {
		t.Fatal("empty filters reached daemon")
	}
	got, err := c.TorrentsByLabel(ctx, "seme")
	if err != nil || len(got) != 1 || got[0].Hash != testHash {
		t.Fatalf("label list: %+v, %v", got, err)
	}
	got, err = c.Torrents(ctx, []string{testHash, "foreign"})
	if err != nil || len(got) != 1 {
		t.Fatalf("hash list leaked foreign torrent: %+v, %v", got, err)
	}
	if _, err := c.Torrent(ctx, "foreign"); !errors.Is(err, downloader.ErrTorrentNotFound) {
		t.Fatalf("foreign read = %v", err)
	}
}

func TestUnownedTorrentNeverMutated(t *testing.T) {
	for _, labels := range [][]string{nil, {"else"}, {"seme-other"}} {
		f, c := newFixture(t, 18)
		f.torrents[0]["labels"] = labels
		ctx := context.Background()
		for name, operation := range map[string]func() error{
			"start": func() error { return c.Start(ctx, testHash) }, "delete": func() error { return c.Delete(ctx, testHash, true) },
			"priority": func() error { return c.SetFilePriority(ctx, testHash, []int{0}, 7) }, "sequential": func() error { return c.SetSequentialDownload(ctx, testHash, true) },
			"piece hint": func() error { return c.PrioritizePieces(ctx, testHash, 0, 1) },
		} {
			if err := operation(); !errors.Is(err, ErrNotOwned) {
				t.Errorf("%s = %v, want ErrNotOwned", name, err)
			}
		}
		if got := f.mutations(); len(got) != 0 {
			t.Fatalf("mutated foreign torrent: %+v", got)
		}
	}
}

func TestAddPolicyAndDuplicates(t *testing.T) {
	ctx := context.Background()
	magnet := "magnet:?xt=urn:btih:" + testHash
	for _, version := range []int{17, 18} {
		f, c := newFixture(t, version)
		if err := c.AddMagnet(ctx, magnet, downloader.AddOptions{SequentialDownload: true}); err != nil {
			t.Fatal(err)
		}
		calls := f.mutations()
		if len(calls) != 3 || calls[0].Method != "torrent_add" || calls[1].Method != "torrent_set" || calls[2].Method != "torrent_start_now" {
			t.Fatalf("add sequence: %+v", calls)
		}
		if calls[0].Args["paused"] != true || calls[0].Args["download_dir"] != "/downloads/seme" || !reflect.DeepEqual(calls[0].Args["labels"], []any{"seme"}) {
			t.Fatalf("unsafe add: %+v", calls[0])
		}
		if calls[1].Args["seed_ratio_mode"] != float64(2) || calls[1].Args["seed_idle_mode"] != float64(2) {
			t.Fatalf("missing unlimited seeding policy: %+v", calls[1])
		}
		if calls[0].Modern != (version >= 18) || calls[1].Modern != (version >= 18) {
			t.Fatalf("wrong protocol: %+v", calls)
		}
		if version == 17 && calls[0].Args["sequential_download"] != nil {
			t.Fatal("old daemon sent unsupported sequential option")
		}
	}
	for _, owned := range []bool{false, true} {
		f, c := newFixture(t, 18)
		f.duplicate = true
		if !owned {
			f.torrents[0]["labels"] = []string{"personal"}
		}
		err := c.AddMagnet(ctx, magnet, downloader.AddOptions{})
		if owned && err != nil || !owned && !errors.Is(err, ErrNotOwned) {
			t.Fatalf("owned %v: %v", owned, err)
		}
		if calls := f.mutations(); len(calls) != 1 || calls[0].Method != "torrent_add" {
			t.Fatalf("duplicate was modified: %+v", calls)
		}
	}
	f, c := newFixture(t, 16)
	if err := c.AddMagnet(ctx, magnet, downloader.AddOptions{}); !errors.Is(err, downloader.ErrNotSupported) {
		t.Fatalf("old add = %v", err)
	}
	if len(f.mutations()) != 0 {
		t.Fatal("old add reached daemon")
	}
	_, c = newFixture(t, 18)
	if err := c.AddMagnet(ctx, magnet, downloader.AddOptions{Category: "other"}); err == nil {
		t.Fatal("foreign category accepted")
	}
	c.label = ""
	if err := c.AddMagnet(ctx, magnet, downloader.AddOptions{}); err == nil {
		t.Fatal("empty label accepted")
	}
}

func TestFilePrioritiesAndStart(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		priority int
		key      string
	}{{0, "files_unwanted"}, {1, "priority_low"}, {4, "priority_normal"}, {6, "priority_high"}, {7, "priority_high"}} {
		f, c := newFixture(t, 18)
		if err := c.SetFilePriority(ctx, testHash, []int{0}, tc.priority); err != nil {
			t.Fatal(err)
		}
		calls := f.mutations()
		if len(calls) != 1 || !reflect.DeepEqual(calls[0].Args[tc.key], []any{float64(0)}) {
			t.Fatalf("priority %d: %+v", tc.priority, calls)
		}
		if tc.priority > 0 && calls[0].Args["files_wanted"] == nil {
			t.Fatal("priority failed to restore wanted flag")
		}
	}
	f, c := newFixture(t, 18)
	if err := c.SetFilePriority(ctx, testHash, nil, 7); err != nil {
		t.Fatal(err)
	}
	if err := c.SetFilePriority(ctx, testHash, []int{999}, 7); err == nil {
		t.Fatal("invalid index accepted")
	}
	if err := c.SetFilePriority(ctx, testHash, []int{0}, 8); err == nil {
		t.Fatal("invalid priority accepted")
	}
	if len(f.mutations()) != 0 {
		t.Fatal("empty or invalid priority mutated daemon")
	}
	if err := c.Start(ctx, testHash); err != nil {
		t.Fatal(err)
	}
	if calls := f.mutations(); len(calls) != 2 || calls[0].Args["seed_ratio_mode"] != float64(2) || calls[1].Method != "torrent_start_now" {
		t.Fatalf("start policy: %+v", calls)
	}
}

func TestSequentialAndHintArbitration(t *testing.T) {
	ctx := context.Background()
	_, old := newFixture(t, 17)
	if err := old.SetSequentialDownload(ctx, testHash, true); !errors.Is(err, downloader.ErrNotSupported) {
		t.Fatalf("old sequential = %v", err)
	}
	if err := old.PrioritizePieces(ctx, testHash, 0, 1); !errors.Is(err, downloader.ErrNotSupported) {
		t.Fatalf("old piece hints = %v", err)
	}
	f, c := newFixture(t, 18)
	if err := c.SetFirstLastPiecePrio(ctx, testHash, true); !errors.Is(err, downloader.ErrNotSupported) {
		t.Fatalf("first/last = %v", err)
	}
	if err := c.SetSequentialDownload(ctx, testHash, false); err != nil {
		t.Fatal(err)
	}
	if err := c.PrioritizePieces(ctx, testHash, 1, 2); err != nil {
		t.Fatal(err)
	}
	hint := c.pieceHint(testHash)
	hint.mu.Lock()
	started := hint.started
	hint.mu.Unlock()
	if err := c.PrioritizePieces(ctx, testHash, 1, 2); err != nil {
		t.Fatal(err)
	}
	if err := c.PrioritizePieces(ctx, testHash, 8, 9); !errors.Is(err, downloader.ErrHintDeclined) {
		t.Fatalf("competing hint = %v", err)
	}
	hint.mu.Lock()
	if hint.started != started {
		t.Error("repeated hints renewed absolute lease")
	}
	hint.started = time.Now().Add(-11 * time.Second)
	hint.mu.Unlock()
	if err := c.PrioritizePieces(ctx, testHash, 8, 9); err != nil {
		t.Fatalf("expired lease: %v", err)
	}
	f.mu.Lock()
	f.torrents[0]["pieces"] = base64.StdEncoding.EncodeToString([]byte{0x81, 0xc0})
	f.mu.Unlock()
	if err := c.PrioritizePieces(ctx, testHash, 1, 2); err != nil {
		t.Fatalf("completed active range: %v", err)
	}
	if err := c.PrioritizePieces(ctx, testHash, 10, 11); !errors.Is(err, downloader.ErrHintDeclined) {
		t.Fatalf("unresolved range = %v", err)
	}
	calls := f.mutations()
	if len(calls) != 4 || calls[1].Args["sequential_download_from_piece"] != float64(1) || calls[2].Args["sequential_download_from_piece"] != float64(8) || calls[3].Args["sequential_download_from_piece"] != float64(1) {
		t.Fatalf("cursor mutations: %+v", calls)
	}
}

func TestStateMapping(t *testing.T) {
	want := []string{downloader.StatePaused, downloader.StateChecking, downloader.StateChecking, downloader.StateQueued, downloader.StateDownloading, downloader.StateQueued, downloader.StateSeeding}
	for status, state := range want {
		if got := normalizeState(status, 0); got != state {
			t.Errorf("status %d: %s", status, got)
		}
	}
	if got := normalizeState(6, 1); got != downloader.StateError {
		t.Fatalf("error state = %s", got)
	}
}

func TestTorrentFileStoppedAndFreshOwnershipChecks(t *testing.T) {
	f, c := newFixture(t, 18)
	ctx := context.Background()
	raw := []byte("d4:infod6:lengthi1e4:name4:testee")
	if err := c.AddTorrentFile(ctx, raw, downloader.AddOptions{Stopped: true}); err != nil {
		t.Fatal(err)
	}
	calls := f.mutations()
	if len(calls) != 2 || calls[0].Args["metainfo"] != base64.StdEncoding.EncodeToString(raw) || calls[1].Method != "torrent_set" {
		t.Fatalf("stopped add = %+v", calls)
	}
	// Removing our label after the torrent was previously read must revoke
	// authority. Cached prior reads must not permit a later start or delete.
	if _, err := c.Torrent(ctx, testHash); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.torrents[0]["labels"] = []string{"personal"}
	f.mu.Unlock()
	if err := c.Start(ctx, testHash); !errors.Is(err, ErrNotOwned) {
		t.Fatalf("start after unlabel = %v", err)
	}
	if err := c.Delete(ctx, testHash, true); !errors.Is(err, ErrNotOwned) {
		t.Fatalf("delete after unlabel = %v", err)
	}
	if len(f.mutations()) != 2 {
		t.Fatal("revoked ownership was cached")
	}
}

func TestOldLabelSupportFailsSafely(t *testing.T) {
	f, c := newFixture(t, 15)
	if _, err := c.TorrentsByLabel(context.Background(), "seme"); !errors.Is(err, downloader.ErrNotSupported) {
		t.Fatalf("unavailable labels = %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, call := range f.calls {
		if call.Method != "session_get" {
			t.Fatalf("unsupported labels reached torrent API: %+v", call)
		}
	}
}

func TestLegacyWireKeys(t *testing.T) {
	got := legacyArgs(map[string]any{"fields": []string{"download_dir", "piece_count", "file_stats", "tracker_stats"}, "ids": []string{testHash}}, "torrent_get")
	if !reflect.DeepEqual(got["fields"], []string{"downloadDir", "pieceCount", "fileStats", "trackerStats"}) {
		t.Fatalf("legacy torrent fields = %+v", got)
	}
	got = legacyArgs(map[string]any{"download_dir": "/downloads", "files_wanted": []int{0}, "seed_ratio_mode": 2, "seed_idle_mode": 2}, "torrent_add")
	if got["download-dir"] != "/downloads" || got["seedRatioMode"] != 2 || got["seedIdleMode"] != 2 || got["files-wanted"] == nil {
		t.Fatalf("legacy add/set fields = %+v", got)
	}
}

func TestTimeoutAndBoundedHandshake(t *testing.T) {
	t.Run("deadline", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-r.Context().Done():
			case <-time.After(100 * time.Millisecond):
			}
		}))
		defer srv.Close()
		c := New(srv.URL, "", "", "seme", "")
		c.http.Timeout = 20 * time.Millisecond
		if _, err := c.Version(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("timeout error = %v", err)
		}
	})
	t.Run("repeated 409", func(t *testing.T) {
		count := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			count++
			w.Header().Set("X-Transmission-Session-Id", "rotating")
			w.WriteHeader(409)
		}))
		defer srv.Close()
		c := New(srv.URL, "", "", "seme", "")
		if _, err := c.Version(context.Background()); err == nil || !strings.Contains(err.Error(), "three attempts") {
			t.Fatalf("handshake error = %v", err)
		}
		if count != 3 {
			t.Fatalf("unbounded handshake: %d requests", count)
		}
	})
}

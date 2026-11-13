package transmission

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Client implements Transmission's RPC API. It never changes session settings.
// Each mutating operation verifies the configured ownership label first.
type Client struct {
	url, username, password, label, downloadDir string
	http                                        *http.Client
	initErr                                     error
	tokenMu                                     sync.RWMutex
	token                                       string
	versionMu                                   sync.Mutex
	version                                     string
	rpcVersion                                  int
	hintMu                                      sync.Mutex
	hints                                       map[string]*pieceHint
}

// New creates a lazily connected client. url may include a custom RPC path;
// a host-only URL uses /transmission/rpc. downloadDir overrides the daemon's
// default for new torrents and free-space checks.
func New(endpoint, username, password, label, downloadDir string) *Client {
	c := &Client{username: username, password: password, label: strings.TrimSpace(label), downloadDir: downloadDir,
		http: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		c.initErr = errors.New("transmission: RPC URL must be an absolute http or https URL")
		return c
	}
	if u.User != nil {
		if username == "" {
			c.username = u.User.Username()
			c.password, _ = u.User.Password()
		}
		u.User = nil
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/transmission/rpc"
	}
	c.url = u.String()
	return c
}

// The compatibility protocol remains available in Transmission 4.1. We use it
// only to discover the RPC version; RPC18+ calls use native JSON-RPC 2.0.
func (c *Client) capabilities(ctx context.Context) (int, error) {
	c.versionMu.Lock()
	defer c.versionMu.Unlock()
	if c.rpcVersion != 0 {
		return c.rpcVersion, nil
	}
	var s session
	if err := c.call(ctx, "session_get", nil, &s, false); err != nil {
		return 0, err
	}
	if s.RPCVersion <= 0 {
		return 0, errors.New("transmission: missing RPC version")
	}
	c.rpcVersion, c.version = s.RPCVersion, s.Version
	return c.rpcVersion, nil
}

func (c *Client) rpc(ctx context.Context, method string, args map[string]any, out any) error {
	v, err := c.capabilities(ctx)
	if err != nil {
		return err
	}
	return c.call(ctx, method, args, out, v >= 18)
}

func (c *Client) call(ctx context.Context, method string, args map[string]any, out any, modern bool) error {
	if c.initErr != nil {
		return c.initErr
	}
	if args == nil {
		args = map[string]any{}
	}
	request := map[string]any{"method": method, "params": args, "jsonrpc": "2.0", "id": 1}
	if !modern {
		request = map[string]any{"method": strings.ReplaceAll(method, "_", "-"), "arguments": legacyArgs(args, method)}
	}
	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("transmission %s request: %w", method, err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
		if err != nil {
			return fmt.Errorf("transmission %s request: %w", method, err)
		}
		req.Header.Set("Content-Type", "application/json")
		c.tokenMu.RLock()
		token := c.token
		c.tokenMu.RUnlock()
		if token != "" {
			req.Header.Set("X-Transmission-Session-Id", token)
		}
		if c.username != "" || c.password != "" {
			req.SetBasicAuth(c.username, c.password)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return fmt.Errorf("transmission %s: %w", method, err)
		}
		if resp.StatusCode == http.StatusConflict {
			next := resp.Header.Get("X-Transmission-Session-Id")
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			if next == "" {
				return errors.New("transmission: HTTP 409 without session ID")
			}
			c.tokenMu.Lock()
			c.token = next
			c.tokenMu.Unlock()
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return fmt.Errorf("transmission %s: HTTP %d", method, resp.StatusCode)
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, (64<<20)+1))
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("transmission %s response: %w", method, err)
		}
		if len(raw) > 64<<20 {
			return errors.New("transmission: RPC response exceeds 64 MiB")
		}
		var envelope struct {
			Arguments json.RawMessage `json:"arguments"`
			Result    json.RawMessage `json:"result"`
			Error     *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return fmt.Errorf("transmission %s: invalid JSON response: %w", method, err)
		}
		if envelope.Error != nil {
			return fmt.Errorf("transmission %s: RPC error %d: %s", method, envelope.Error.Code, envelope.Error.Message)
		}
		result := envelope.Result
		if !modern {
			var status string
			if err := json.Unmarshal(result, &status); err != nil || status == "" {
				return fmt.Errorf("transmission %s: missing RPC result", method)
			}
			if status != "success" {
				return fmt.Errorf("transmission %s: %s", method, status)
			}
			result = envelope.Arguments
			var value any
			decoder := json.NewDecoder(bytes.NewReader(result))
			decoder.UseNumber()
			if err := decoder.Decode(&value); err != nil {
				return fmt.Errorf("transmission %s: invalid arguments: %w", method, err)
			}
			result, err = json.Marshal(normalizeLegacy(value))
			if err != nil {
				return err
			}
		}
		if len(result) == 0 || bytes.Equal(result, []byte("null")) {
			return fmt.Errorf("transmission %s: missing RPC result", method)
		}
		if out != nil {
			if err := json.Unmarshal(result, out); err != nil {
				return fmt.Errorf("transmission %s response: %w", method, err)
			}
		}
		return nil
	}
	return errors.New("transmission: session ID handshake failed after three attempts")
}

// Legacy RPC uses both camelCase and kebab-case. Keep the translation explicit
// so unsupported newer fields cannot accidentally masquerade as old features.
var legacyKeys = map[string]string{
	"rpc_version": "rpc-version", "rpc_version_semver": "rpc-version-semver",
	"download_dir": "download-dir", "incomplete_dir": "incomplete-dir", "incomplete_dir_enabled": "incomplete-dir-enabled", "rename_partial_files": "rename-partial-files",
	"hash_string": "hashString", "percent_done": "percentDone", "size_when_done": "sizeWhenDone", "left_until_done": "leftUntilDone",
	"rate_download": "rateDownload", "peers_sending_to_us": "peersSendingToUs", "uploaded_ever": "uploadedEver", "upload_ratio": "uploadRatio",
	"seconds_seeding": "secondsSeeding", "added_date": "addedDate", "piece_size": "pieceSize", "piece_count": "pieceCount",
	"file_stats": "fileStats", "bytes_completed": "bytesCompleted", "error_string": "errorString", "tracker_stats": "trackerStats", "seeder_count": "seederCount",
	"files_wanted": "files-wanted", "files_unwanted": "files-unwanted", "priority_low": "priority-low", "priority_normal": "priority-normal", "priority_high": "priority-high",
	"seed_ratio_mode": "seedRatioMode", "seed_idle_mode": "seedIdleMode", "delete_local_data": "delete-local-data", "size_bytes": "size-bytes",
	"torrent_added": "torrent-added", "torrent_duplicate": "torrent-duplicate",
}

func legacyArgs(args map[string]any, method string) map[string]any {
	out := make(map[string]any, len(args))
	for key, value := range args {
		if key == "fields" {
			if fields, ok := value.([]string); ok {
				translated := make([]string, len(fields))
				for i, field := range fields {
					translated[i] = legacyKey(field)
					if field == "download_dir" && method == "torrent_get" {
						translated[i] = "downloadDir"
					}
				}
				value = translated
			}
		}
		out[legacyKey(key)] = value
	}
	return out
}

func legacyKey(key string) string {
	if value, ok := legacyKeys[key]; ok {
		return value
	}
	return key
}

func normalizeLegacy(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			canonical := key
			if key == "downloadDir" {
				canonical = "download_dir"
			} else {
				for modern, legacy := range legacyKeys {
					if key == legacy {
						canonical = modern
						break
					}
				}
			}
			out[canonical] = normalizeLegacy(item)
		}
		return out
	case []any:
		for i := range v {
			v[i] = normalizeLegacy(v[i])
		}
		return v
	default:
		return value
	}
}

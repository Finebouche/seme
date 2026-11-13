// Package torrentio reads torrent streams from a Stremio-compatible Torrentio
// addon. Direct URL/debrid streams are deliberately excluded: playback belongs
// to the local download client.
package torrentio

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const DefaultURL = "https://torrentio.strem.fun"
const DefaultTimeout = 15 * time.Second
const maxResponseBytes = 4 << 20

// Result identifies a file, not just a torrent. A nil FileIndex means the
// provider did not specify one; an explicit zero is a valid selection.
type Result struct {
	InfoHash     string
	FileIndex    *int
	MagnetURL    string
	Name         string
	Title        string
	Filename     string
	Size         int64
	Seeders      int
	SizeKnown    bool
	SeedersKnown bool
}

type Client struct {
	base *url.URL
	http *http.Client
}

// Manifest probes the configured addon using the same normalization, timeout,
// response bound and redacted errors as discovery. It requires a Stremio addon
// that advertises the stream resource, rather than accepting any JSON server.
func (c *Client) Manifest(ctx context.Context) error {
	u := *c.base
	u.Path += "/manifest.json"
	u.RawPath = strings.TrimRight(c.base.EscapedPath(), "/") + "/manifest.json"
	body, err := c.read(ctx, &u)
	if err != nil {
		return err
	}
	var manifest struct {
		ID        string            `json:"id"`
		Resources []json.RawMessage `json:"resources"`
	}
	if json.Unmarshal(body, &manifest) != nil || strings.TrimSpace(manifest.ID) == "" {
		return fmt.Errorf("torrentio: invalid addon manifest")
	}
	for _, raw := range manifest.Resources {
		var name string
		if json.Unmarshal(raw, &name) == nil && name == "stream" {
			return nil
		}
		var resource struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &resource) == nil && resource.Name == "stream" {
			return nil
		}
	}
	return fmt.Errorf("torrentio: addon manifest does not advertise streams")
}

// New accepts an addon root, configured addon URL, or manifest URL. stremio://
// installation links use HTTPS. Credentials and query strings are not accepted
// because Stremio addon configuration is carried in the URL path.
func New(addonURL string, timeout time.Duration) (*Client, error) {
	if strings.TrimSpace(addonURL) == "" {
		addonURL = DefaultURL
	}
	u, err := url.Parse(strings.TrimSpace(addonURL))
	if err != nil {
		return nil, fmt.Errorf("torrentio: invalid addon URL")
	}
	if u.Scheme == "stremio" {
		u.Scheme = "https"
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return nil, fmt.Errorf("torrentio: expected HTTP(S) addon root or manifest URL without credentials, query, or fragment")
	}
	escapedPath := strings.TrimSuffix(strings.TrimRight(u.EscapedPath(), "/"), "/manifest.json")
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/manifest.json")
	u.RawPath = escapedPath
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{base: u, http: &http.Client{Timeout: timeout}}, nil
}

// Streams returns only valid BitTorrent results. Malformed individual streams
// are skipped, while an invalid response envelope fails the request.
func (c *Client) Streams(ctx context.Context, typ, id string) ([]Result, error) {
	if typ != "movie" && typ != "series" {
		return nil, fmt.Errorf("torrentio: unsupported content type")
	}
	u := *c.base
	u.Path += "/stream/" + typ + "/" + id + ".json"
	u.RawPath = strings.TrimRight(c.base.EscapedPath(), "/") + "/stream/" + typ + "/" + url.PathEscape(id) + ".json"
	body, err := c.read(ctx, &u)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Streams []json.RawMessage `json:"streams"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("torrentio: invalid stream response")
	}
	out := make([]Result, 0, len(envelope.Streams))
	seen := map[string]bool{}
	for _, raw := range envelope.Streams {
		res, ok := normalize(raw)
		if !ok {
			continue
		}
		idx := "auto"
		if res.FileIndex != nil {
			idx = strconv.Itoa(*res.FileIndex)
		}
		key := res.InfoHash + ":" + idx
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, res)
	}
	return out, nil
}

func (c *Client) read(ctx context.Context, u *url.URL) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("torrentio: invalid request")
	}
	req.Header.Set("Accept", "application/json")
	// Identify this addon explicitly: Torrentio rejects Go's generic default
	// User-Agent. Keep the identity honest rather than impersonating Stremio.
	req.Header.Set("User-Agent", "Seme/0.1 (+https://github.com/Finebouche/seme)")
	resp, err := c.http.Do(req)
	// Do not include transport errors: a configured path may contain secrets.
	if err != nil {
		return nil, fmt.Errorf("torrentio: request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("torrentio: addon returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("torrentio: read response")
	}
	if len(body) > maxResponseBytes {
		return nil, fmt.Errorf("torrentio: response too large")
	}
	return body, nil
}

var seedPattern = regexp.MustCompile(`👤\s*([0-9]+)`)
var sizePattern = regexp.MustCompile(`💾\s*([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB|KB|B)`)

func normalize(raw json.RawMessage) (Result, bool) {
	var stream struct {
		InfoHash      string          `json:"infoHash"`
		FileIndex     json.RawMessage `json:"fileIdx"`
		Name          string          `json:"name"`
		Title         string          `json:"title"`
		Description   string          `json:"description"`
		Sources       []string        `json:"sources"`
		BehaviorHints struct {
			Filename  string `json:"filename"`
			VideoSize int64  `json:"videoSize"`
		} `json:"behaviorHints"`
	}
	if json.Unmarshal(raw, &stream) != nil {
		return Result{}, false
	}
	hash := strings.ToLower(strings.TrimSpace(stream.InfoHash))
	decoded, err := hex.DecodeString(hash)
	if err != nil || len(decoded) != 20 {
		return Result{}, false
	}
	var fileIndex *int
	if len(stream.FileIndex) > 0 {
		var index int
		if string(stream.FileIndex) == "null" || json.Unmarshal(stream.FileIndex, &index) != nil || index < 0 {
			return Result{}, false
		}
		fileIndex = &index
	}
	title := stream.Description
	if title == "" {
		title = stream.Title
	}
	if title == "" {
		title = stream.BehaviorHints.Filename
	}
	if title == "" {
		title = stream.Name
	}
	if title == "" {
		title = hash
	}
	v := url.Values{"xt": {"urn:btih:" + hash}, "dn": {strings.SplitN(title, "\n", 2)[0]}}
	trackers := map[string]bool{}
	for _, source := range stream.Sources {
		// dht:<hash> denotes the swarm already selected by xt. Transmission
		// discovers it through its normal DHT support; it is not a tracker.
		if !strings.HasPrefix(source, "tracker:") {
			continue
		}
		tracker := strings.TrimPrefix(source, "tracker:")
		u, err := url.Parse(tracker)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "udp") {
			continue
		}
		if !trackers[tracker] {
			v.Add("tr", tracker)
			trackers[tracker] = true
		}
	}
	r := Result{InfoHash: hash, FileIndex: fileIndex, MagnetURL: "magnet:?" + v.Encode(), Name: stream.Name, Title: title, Filename: stream.BehaviorHints.Filename}
	if stream.BehaviorHints.VideoSize > 0 {
		r.Size = stream.BehaviorHints.VideoSize
		r.SizeKnown = true
	}
	if m := seedPattern.FindStringSubmatch(title); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			r.Seeders = n
			r.SeedersKnown = true
		}
	}
	if !r.SizeKnown {
		if m := sizePattern.FindStringSubmatch(title); m != nil {
			n, _ := strconv.ParseFloat(m[1], 64)
			unit := map[string]float64{"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}[m[2]]
			if bytes := n * unit; bytes > 0 && bytes < 9.22e18 {
				r.Size = int64(bytes)
				r.SizeKnown = true
			}
		}
	}
	return r, true
}

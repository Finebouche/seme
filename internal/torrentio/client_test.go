package torrentio

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

const hash = "0123456789abcdef0123456789abcdef01234567"

// Captured read-only from Torrentio's public Big Buck Bunny metadata endpoint
// on 2026-11-13. No playback or torrent add is involved in this fixture.
func TestActualTorrentioResponse(t *testing.T) {
	body, err := os.ReadFile("testdata/big-buck-bunny.json")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer server.Close()
	c, _ := New(server.URL, 0)
	results, err := c.Streams(context.Background(), "movie", "tt1254207")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 23 {
		t.Fatalf("decoded %d streams, want 23", len(results))
	}
	first := results[0]
	if first.InfoHash != "f181e166e440b355ce73cc8b988f47ad7e8ea6ab" || first.FileIndex == nil || *first.FileIndex != 0 || first.Seeders != 1 || first.Size != 7100000000 || first.Filename == "" {
		t.Fatalf("first decoded stream = %+v", first)
	}
}

func TestStreamsConfiguredURLAndFileIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.UserAgent(), "Seme/") {
			t.Errorf("missing addon User-Agent: %q", r.UserAgent())
		}
		if r.URL.Path != "/providers=nyaasi|sort=seeders/stream/series/tt123:1:2.json" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Write([]byte(`{"streams":[
		{"name":"Torrentio 1080p","title":"Release\n👤 24 💾 2.5 GB","infoHash":"` + strings.ToUpper(hash) + `","fileIdx":0,"sources":["dht:` + hash + `","tracker:udp://tracker.example:80/announce","tracker:https://tracker.example/announce","tracker:udp://tracker.example:80/announce","tracker:javascript:bad"]},
		{"infoHash":"` + hash + `","fileIdx":1,"behaviorHints":{"filename":"episode.mkv","videoSize":1234}},
		{"infoHash":"` + hash + `","fileIdx":1},
		{"infoHash":"` + hash + `"},
		{"url":"https://debrid.example/file"},
		{"infoHash":"invalid"},
		{"infoHash":"` + hash + `","fileIdx":-1},
		{"infoHash":"` + hash + `","fileIdx":"0"},
		{"infoHash":"` + hash + `","fileIdx":1.2},
		{"infoHash":"` + hash + `","fileIdx":null}
		]}`))
	}))
	defer server.Close()
	c, err := New(server.URL+"/providers=nyaasi|sort=seeders/manifest.json", 0)
	if err != nil {
		t.Fatal(err)
	}
	results, err := c.Streams(context.Background(), "series", "tt123:1:2")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("got %d results: %+v", len(results), results)
	}
	if results[0].FileIndex == nil || *results[0].FileIndex != 0 || results[2].FileIndex != nil {
		t.Fatal("explicit zero and absent fileIdx were conflated")
	}
	m, err := url.Parse(results[0].MagnetURL)
	if err != nil {
		t.Fatal(err)
	}
	if got := m.Query()["tr"]; len(got) != 2 {
		t.Errorf("trackers = %v", got)
	}
	if m.Query().Get("xt") != "urn:btih:"+hash {
		t.Errorf("magnet = %s", m)
	}
	if !results[0].SeedersKnown || results[0].Seeders != 24 || !results[0].SizeKnown || results[0].Size != 2500000000 {
		t.Errorf("hints = %+v", results[0])
	}
	if results[1].Filename != "episode.mkv" || results[1].Size != 1234 {
		t.Errorf("hints = %+v", results[1])
	}
}

func TestInvalidConfiguration(t *testing.T) {
	for _, u := range []string{"file:///tmp/config", "https://user:secret@example.com", "https://example.com?secret=yes", "https://example.com/#frag", "/relative"} {
		if _, err := New(u, 0); err == nil {
			t.Errorf("accepted %q", u)
		}
	}
	c, err := New("stremio://torrentio.strem.fun/config/manifest.json", 0)
	if err != nil {
		t.Fatal(err)
	}
	if c.base.String() != "https://torrentio.strem.fun/config" || c.http.Timeout != DefaultTimeout {
		t.Errorf("client = %+v", c)
	}
}

func TestManifestProbe(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		ok         bool
	}{
		{"string resource", `{"id":"org.stremio.torrentio","resources":["stream"]}`, true},
		{"object resource", `{"id":"org.stremio.torrentio","resources":[{"name":"stream","types":["movie"]}]}`, true},
		{"unrelated JSON", `{"hello":"world"}`, false},
		{"missing stream", `{"id":"other","resources":["catalog"]}`, false},
		{"malformed", `{`, false},
		{"oversized", strings.Repeat(" ", maxResponseBytes+1), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/configured/manifest.json" {
					t.Errorf("manifest path = %q", r.URL.Path)
				}
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			c, err := New(server.URL+"/configured/manifest.json", 0)
			if err != nil {
				t.Fatal(err)
			}
			if err := c.Manifest(context.Background()); (err == nil) != tc.ok {
				t.Errorf("Manifest() = %v, want success %v", err, tc.ok)
			}
		})
	}
}

func TestResponseFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"bad status", http.StatusBadGateway, `{}`},
		{"invalid JSON", http.StatusOK, `{"streams":`},
		{"invalid envelope", http.StatusOK, `{"streams":{}}`},
		{"oversized", http.StatusOK, strings.Repeat(" ", maxResponseBytes+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); w.Write([]byte(tc.body)) }))
			defer server.Close()
			c, _ := New(server.URL, time.Second)
			if _, err := c.Streams(context.Background(), "movie", "tt123"); err == nil {
				t.Fatal("expected response error")
			}
		})
	}
}

func TestRequestTimeoutRedactsConfiguration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	c, _ := New(server.URL+"/secret-token", 20*time.Millisecond)
	_, err := c.Streams(context.Background(), "movie", "tt123")
	if err == nil || strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("error = %v", err)
	}
}

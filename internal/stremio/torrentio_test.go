package stremio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kipsilabs/seedstrem/internal/downloader/fake"
)

func TestTorrentioDiscoveryPlayPreservesFileSelection(t *testing.T) {
	h := newHarness(t)
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/configured/stream/series/tt0944947:1:5.json" {
			t.Errorf("upstream path = %q", r.URL.Path)
		}
		w.Write([]byte(`{"streams":[
		{"infoHash":"` + testHash + `","fileIdx":0,"name":"Torrentio 1080p","title":"Season pack\n👤 42 💾 8 GB","sources":["tracker:udp://tracker.example:80/announce","dht:` + testHash + `"],"behaviorHints":{"filename":"opaque-0.mkv"}},
		{"infoHash":"` + testHash + `","fileIdx":1,"title":"Alternative video"},
		{"url":"https://debrid.example/cached-video"}
		]}`))
	}))
	defer upstream.Close()
	settings := h.handler.settings()
	settings.Torrentio = TorrentioSettings{Enabled: true, URL: upstream.URL + "/configured/manifest.json"}
	settings.Prowlarr = ProwlarrSettings{} // provider works without Prowlarr
	h.handler.settings = func() Settings { return settings }
	h.fakeDC.Update(testHash, func(tor *fake.Torrent) {
		tor.Files = []fake.File{{Name: "opaque-0.mkv", Size: 100}, {Name: "opaque-1.mkv", Size: 1000}, {Name: "Show.S01E05.mkv", Size: 9999}}
	})
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	discover := func() []streamItem {
		t.Helper()
		resp, err := http.Get(h.server.URL + "/stremio/stream/series/tt0944947%3A1%3A5.json")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var payload streamResponse
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if len(payload.Streams) != 2 {
			t.Fatalf("streams = %+v", payload.Streams)
		}
		return payload.Streams
	}
	items := discover()
	for _, call := range h.fakeDC.Calls() {
		if strings.HasPrefix(call, "add") {
			t.Fatalf("discovery added a torrent: %s", call)
		}
	}
	if h.prowlarrHits.Load() != 0 {
		t.Fatal("Torrentio discovery queried Prowlarr")
	}
	play := func(item streamItem, wantIndex int) string {
		t.Helper()
		u, err := url.Parse(item.URL)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(item.URL, h.server.URL+"/stremio/play/") || u.Query().Get("fileIdx") == "" {
			t.Fatalf("play URL = %s", item.URL)
		}
		magnet, _ := url.Parse(u.Query().Get("magnet"))
		if magnet.Query().Get("tr") != "udp://tracker.example:80/announce" && wantIndex == 0 {
			t.Fatalf("lost trackers: %s", magnet)
		}
		resp, err := client.Get(item.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusFound {
			t.Fatalf("play status = %d", resp.StatusCode)
		}
		token := strings.TrimPrefix(resp.Header.Get("Location"), h.server.URL+"/dl/")
		link, err := h.db.LinkByToken(context.Background(), token)
		if err != nil {
			t.Fatal(err)
		}
		if link.FileIndex != wantIndex {
			t.Fatalf("selected %d, want %d", link.FileIndex, wantIndex)
		}
		return token
	}
	firstToken := play(items[0], 0)
	play(items[1], 1)
	// The owned path still preserves every provider file variant rather than
	// rebuilding a hash-only URL and accidentally selecting S01E05 by name.
	items = discover()
	if repeatToken := play(items[0], 0); repeatToken != firstToken {
		t.Fatal("repeat play did not reuse selected file link")
	}
	if hits.Load() != 2 {
		t.Fatalf("provider requests = %d", hits.Load())
	}
}

func TestPlayRejectsInvalidExplicitIndex(t *testing.T) {
	h := newHarness(t)
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	for _, value := range []string{"", "-1", "garbage", "0&fileIdx=1"} {
		u := h.server.URL + "/stremio/play/" + testHash + "?magnet=" + url.QueryEscape(testMagnet()) + "&fileIdx=" + value
		resp, err := client.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("fileIdx %q: status %d", value, resp.StatusCode)
		}
	}
	for _, call := range h.fakeDC.Calls() {
		if strings.HasPrefix(call, "add") {
			t.Fatalf("invalid selection added torrent: %s", call)
		}
	}
}

func TestTorrentioPlayMissingAndOutOfRangeIndex(t *testing.T) {
	h := newHarness(t)
	h.fakeDC.Update(testHash, func(tor *fake.Torrent) {
		tor.Files = []fake.File{{Name: "Show.S01E04.mkv", Size: 1000}, {Name: "Show.S01E05.mkv", Size: 100}}
	})
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	base := h.server.URL + "/stremio/play/" + testHash + "?magnet=" + url.QueryEscape(testMagnet()) + "&series=1&s=1&e=5"
	// An explicit missing index must not silently pick the episode by name.
	resp, err := client.Get(base + "&fileIdx=99")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("out of range status = %d", resp.StatusCode)
	}
	// A provider that omits fileIdx retains the existing episode matcher.
	resp, err = client.Get(base)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("fallback status = %d", resp.StatusCode)
	}
	token := strings.TrimPrefix(resp.Header.Get("Location"), h.server.URL+"/dl/")
	link, err := h.db.LinkByToken(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if link.FileIndex != 1 {
		t.Fatalf("fallback file = %d, want episode index 1", link.FileIndex)
	}
}

package stremio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kipsilabs/seedstrem/internal/downloader"
	"github.com/kipsilabs/seedstrem/internal/downloader/fake"
	"github.com/kipsilabs/seedstrem/internal/meta"
	"github.com/kipsilabs/seedstrem/internal/store"
	"github.com/kipsilabs/seedstrem/internal/torrents"
)

func seedHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	settings := h.handler.settings
	h.handler.settings = func() Settings { s := settings(); s.ManagedLabel = "seme"; return s }
	return h
}

func seedFixture(t *testing.T, h *harness, n int, state string, at int64) store.Torrent {
	t.Helper()
	tor := store.Torrent{ID: fmt.Sprintf("SEED%09d", n), Hash: fmt.Sprintf("%040x", n), Name: fmt.Sprintf("Release.%d.1080p", n), AddedAt: at, Phase: store.PhaseSelected}
	if err := h.db.InsertTorrent(context.Background(), tor); err != nil {
		t.Fatal(err)
	}
	h.fakeDC.Put(&fake.Torrent{Hash: tor.Hash, Name: tor.Name, Category: "seme", State: state, Progress: 1, Uploaded: 3 << 30, Ratio: 1.25, Files: []fake.File{{Name: "episode.mkv", Size: 100, Progress: 1, Priority: 1}}})
	return tor
}

func seedGET(t *testing.T, h *harness, path string, dst any) {
	t.Helper()
	resp, err := http.Get(h.server.URL + "/stremio" + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Cache-Control"), "max-age=0") {
		t.Errorf("freshness header = %q", resp.Header.Get("Cache-Control"))
	}
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		t.Fatal(err)
	}
}

func TestSeedingManifestScope(t *testing.T) {
	m := BuildManifest("1.2.3", AddonSettings{EnableMovies: true, EnableSeries: true, EnableAnime: true})
	if len(m.Catalogs) != 1 || m.Catalogs[0].ID != seedCatalogID || m.Catalogs[0].Type != seedType || m.Catalogs[0].Name != "Sème — Currently seeding" {
		t.Fatalf("catalogs=%+v", m.Catalogs)
	}
	if !reflect.DeepEqual(m.Catalogs[0].Extra, []CatalogExtra{{Name: "skip"}}) {
		t.Fatalf("pagination=%+v", m.Catalogs[0].Extra)
	}
	names := map[string]bool{}
	for _, resource := range m.Resources {
		if names[resource.Name] {
			t.Fatalf("duplicate resource %q: Stremio selects its first occurrence", resource.Name)
		}
		names[resource.Name] = true
		switch resource.Name {
		case "meta":
			if !reflect.DeepEqual(resource.Types, []string{seedType}) || !reflect.DeepEqual(resource.IDPrefixes, []string{seedIDPrefix}) {
				t.Errorf("metadata scope=%+v", resource)
			}
		case "stream":
			for _, typ := range []string{"movie", "series", "anime", seedType} {
				if !slices.Contains(resource.Types, typ) {
					t.Errorf("missing stream type %s", typ)
				}
			}
			for _, prefix := range []string{"tt", "kitsu", "mal", "anilist", "anidb", seedIDPrefix} {
				if !slices.Contains(resource.IDPrefixes, prefix) {
					t.Errorf("missing stream prefix %s", prefix)
				}
			}
		}
	}
	if !names["stream"] || !names["catalog"] || !names["meta"] {
		t.Fatalf("resources=%+v", m.Resources)
	}
}

func TestSeedingCatalogLiveFilterAndStats(t *testing.T) {
	h := seedHarness(t)
	a := seedFixture(t, h, 1, downloader.StateSeeding, 10)
	b := seedFixture(t, h, 2, downloader.StateSeeding, 20) // Seeding can be idle.
	for i, state := range []string{downloader.StatePaused, downloader.StateDownloading, downloader.StateError, downloader.StateChecking, downloader.StateQueued} {
		seedFixture(t, h, i+3, state, 30)
	}
	sticky := seedFixture(t, h, 8, downloader.StateSeeding, 30)
	if err := h.db.SetTorrentError(context.Background(), sticky.ID, "local error"); err != nil {
		t.Fatal(err)
	}
	foreign := seedFixture(t, h, 9, downloader.StateSeeding, 30)
	h.fakeDC.Update(foreign.Hash, func(tor *fake.Torrent) { tor.Category = "other" })
	removed := seedFixture(t, h, 10, downloader.StateSeeding, 30)
	h.fakeDC.Remove(removed.Hash)
	h.fakeDC.Put(&fake.Torrent{Hash: strings.Repeat("e", 40), Category: "seme", State: downloader.StateSeeding, Name: "Unstored"})
	var response seedCatalogResponse
	seedGET(t, h, "/catalog/other/seme-seeding.json", &response)
	if len(response.Metas) != 2 {
		t.Fatalf("catalog=%+v", response.Metas)
	}
	if response.Metas[0].ID != seedIDPrefix+b.ID || response.Metas[1].ID != seedIDPrefix+a.ID {
		t.Fatalf("order=%+v", response.Metas)
	}
	for _, item := range response.Metas {
		for _, want := range []string{"Torrent-wide uploaded: 3.00 GiB", "Ratio: 1.25", "Selected-file download progress: 100.0%", "Seeding selected files", "may be idle", "Snapshot:", "does not imply the full torrent is complete"} {
			if !strings.Contains(item.Description, want) {
				t.Errorf("description %q missing %q", item.Description, want)
			}
		}
		if item.Poster != h.server.URL+"/icon-512.png" {
			t.Errorf("fallback poster=%q", item.Poster)
		}
	}
	if response.CacheMaxAge != 0 || response.StaleRevalidate != 0 {
		t.Errorf("cache=%+v", response)
	}
	assertSeedReadOnly(t, h)
}

func assertSeedReadOnly(t *testing.T, h *harness) {
	t.Helper()
	if h.prowlarrHits.Load() != 0 {
		t.Fatalf("provider queried %d times", h.prowlarrHits.Load())
	}
	for _, call := range h.fakeDC.Calls() {
		if !strings.HasPrefix(call, "torrentsByLabel ") {
			t.Errorf("unexpected downloader mutation/call: %s", call)
		}
	}
}

func TestSeedingDetailAndReplayAreReadOnly(t *testing.T) {
	h := seedHarness(t)
	tor := seedFixture(t, h, 1, downloader.StateSeeding, 10)
	links := []store.Link{
		{Token: "existing-video", TorrentID: tor.ID, FileIndex: 0, Path: "episode.mkv", Bytes: 100},
		{Token: "existing-text", TorrentID: tor.ID, FileIndex: 1, Path: "readme.txt", Bytes: 10},
		{Token: "incomplete", TorrentID: tor.ID, FileIndex: 2, Path: "next.mkv", Bytes: 100},
	}
	if err := h.db.InsertLinks(context.Background(), links); err != nil {
		t.Fatal(err)
	}
	h.fakeDC.Update(tor.Hash, func(tor *fake.Torrent) {
		tor.State = downloader.StatePaused
		tor.Files = append(tor.Files, fake.File{Name: "readme.txt", Size: 10, Progress: 1, Priority: 1}, fake.File{Name: "next.mkv", Size: 100, Progress: .5, Priority: 1})
	})
	var detail seedMetaResponse
	path := "/meta/other/" + url.PathEscape(seedIDPrefix+tor.ID) + ".json"
	seedGET(t, h, path, &detail)
	if detail.Meta == nil || !strings.Contains(detail.Meta.Description, "Status: Paused") {
		t.Fatalf("stale detail=%+v", detail)
	}
	var catalog seedCatalogResponse
	seedGET(t, h, "/catalog/other/seme-seeding.json", &catalog)
	if len(catalog.Metas) != 0 {
		t.Fatalf("paused torrent in catalog: %+v", catalog)
	}
	var streams streamResponse
	seedGET(t, h, "/stream/other/"+url.PathEscape(seedIDPrefix+tor.ID)+".json", &streams)
	if len(streams.Streams) != 1 || streams.Streams[0].URL != h.server.URL+"/dl/existing-video" {
		t.Fatalf("streams=%+v", streams.Streams)
	}
	if !strings.Contains(streams.Streams[0].Description, "episode.mkv") {
		t.Fatalf("file identity lost: %+v", streams.Streams[0])
	}
	if hints := streams.Streams[0].BehaviorHints; hints["filename"] != "episode.mkv" || hints["notWebReady"] != true || hints["videoSize"] == nil {
		t.Fatalf("playback identification missing: %+v", hints)
	}
	after, err := h.db.LinksByTorrent(context.Background(), tor.ID)
	if err != nil || !reflect.DeepEqual(after, links) {
		t.Fatalf("links changed: %+v, %v", after, err)
	}
	assertSeedReadOnly(t, h)
	h.fakeDC.Remove(tor.Hash)
	seedGET(t, h, path, &detail)
	if detail.Meta != nil {
		t.Fatalf("removed detail leaked: %+v", detail.Meta)
	}
	seedGET(t, h, "/stream/other/"+url.PathEscape(seedIDPrefix+tor.ID)+".json", &streams)
	if len(streams.Streams) != 0 {
		t.Fatal("removed streams leaked")
	}
}

func TestSeedingPaginationAndInvalidIDs(t *testing.T) {
	h := seedHarness(t)
	for i := 1; i <= seedPageSize+1; i++ {
		seedFixture(t, h, i, downloader.StateSeeding, int64(i))
	}
	var response seedCatalogResponse
	seedGET(t, h, "/catalog/other/seme-seeding.json", &response)
	if len(response.Metas) != seedPageSize {
		t.Fatalf("page size=%d", len(response.Metas))
	}
	seedGET(t, h, fmt.Sprintf("/catalog/other/seme-seeding/skip=%d.json", seedPageSize), &response)
	if len(response.Metas) != 1 || response.Metas[0].ID != seedIDPrefix+"SEED000000001" {
		t.Fatalf("last page=%+v", response)
	}
	for _, extra := range []string{"skip=-1", "skip=no", "skip=999999999999999999999999", "skip=999", "skip=0&skip=1", "search=secret"} {
		seedGET(t, h, "/catalog/other/seme-seeding/"+extra+".json", &response)
		if len(response.Metas) != 0 {
			t.Errorf("invalid extra %s returned items", extra)
		}
	}
	calls := len(h.fakeDC.Calls())
	for _, id := range []string{"tt1234", "seme:seed:", "seme:seed:../secret", "seme:seed:foreign"} {
		var detail seedMetaResponse
		seedGET(t, h, "/meta/other/"+url.PathEscape(id)+".json", &detail)
		if detail.Meta != nil {
			t.Errorf("invalid id leaked %+v", detail.Meta)
		}
		var streams streamResponse
		seedGET(t, h, "/stream/other/"+url.PathEscape(id)+".json", &streams)
		if len(streams.Streams) != 0 {
			t.Errorf("invalid id returned streams")
		}
	}
	if len(h.fakeDC.Calls()) != calls+2 {
		t.Errorf("malformed IDs should not query download client; calls=%v", h.fakeDC.Calls()[calls:])
	}
	assertSeedReadOnly(t, h)
}

func TestSeedingUnavailableClient(t *testing.T) {
	h := seedHarness(t)
	tor := seedFixture(t, h, 1, downloader.StateSeeding, 10)
	h.fakeDC.SetTorrentsByLabelErr(errors.New("client offline"))
	for _, path := range []string{"/catalog/other/seme-seeding.json", "/meta/other/" + seedIDPrefix + tor.ID + ".json", "/stream/other/" + seedIDPrefix + tor.ID + ".json"} {
		resp, err := http.Get(h.server.URL + "/stremio" + path)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusServiceUnavailable || body["error"] == nil {
			t.Fatalf("offline response: %d %+v %v", resp.StatusCode, body, err)
		}
	}
	assertSeedReadOnly(t, h)
}

func TestSeedingPosterMetadataAndBudget(t *testing.T) {
	h := seedHarness(t)
	tor := seedFixture(t, h, 1, downloader.StateSeeding, 10)
	if err := h.db.SetTorrentContent(context.Background(), tor.ID, "tt", "tt123", 2, 3); err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/meta/series/tt123.json" {
			t.Errorf("metadata path=%s", r.URL.Path)
		}
		w.Write([]byte(`{"meta":{"name":"Known series","poster":"https://example.org/poster.jpg"}}`))
	}))
	defer server.Close()
	h.handler.meta = meta.New(server.URL, "")
	var detail seedMetaResponse
	seedGET(t, h, "/meta/other/"+seedIDPrefix+tor.ID+".json", &detail)
	if detail.Meta == nil || detail.Meta.Poster != "https://example.org/poster.jpg" || !strings.Contains(detail.Meta.Name, "Known series") || !strings.Contains(detail.Meta.Description, tor.Name) || !strings.Contains(detail.Meta.Description, "Original content selection: S02E03") {
		t.Fatalf("detail=%+v", detail.Meta)
	}
	if hits.Load() != 1 {
		t.Errorf("metadata hits=%d", hits.Load())
	}
	stalled := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer stalled.Close()
	h.handler.meta = meta.New(stalled.URL, "")
	start := time.Now()
	seedGET(t, h, "/meta/other/"+seedIDPrefix+tor.ID+".json", &detail)
	if time.Since(start) > 3*time.Second {
		t.Errorf("metadata budget exceeded: %s", time.Since(start))
	}
	if detail.Meta == nil || detail.Meta.Poster != h.server.URL+"/icon-512.png" {
		t.Fatalf("offline fallback=%+v", detail.Meta)
	}
	assertSeedReadOnly(t, h)
}

func TestSeedingInvalidRatios(t *testing.T) {
	if got := seedStats(torrents.SeedTorrent{Info: downloader.TorrentInfo{Ratio: 0, RatioUnavailable: true}}); !strings.Contains(got, "Ratio: n/a") {
		t.Errorf("unavailable ratio displayed as zero: %s", got)
	}

	for _, ratio := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		got := seedStats(torrents.SeedTorrent{Info: downloader.TorrentInfo{Ratio: ratio}})
		if !strings.Contains(got, "Ratio: n/a") {
			t.Errorf("ratio %v: %s", ratio, got)
		}
	}
}

package admin

import (
	"context"
	"encoding/json"
	"github.com/kipsilabs/seedstrem/internal/config"
	"github.com/kipsilabs/seedstrem/internal/downloader/fake"
	"github.com/kipsilabs/seedstrem/internal/store"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSemeDTORoundTripAndRedaction(t *testing.T) {
	cfg := config.Default()
	cfg.Transmission.Username = "user"
	cfg.Transmission.Password = "private-password"
	cfg.Transmission.DownloadDir = "/downloads"
	cfg.Torrentio.Timeout = 33 * time.Second
	dto := toDTO(cfg)
	if dto.Transmission.Password != passwordMask {
		t.Fatal("Transmission password exposed")
	}
	got := dto.apply(cfg)
	if got.Transmission != cfg.Transmission || got.Torrentio != cfg.Torrentio || !got.Cleanup.KeepForever {
		t.Fatal("new settings lost in DTO round trip")
	}
	dto.Transmission.Password = ""
	if got := dto.apply(cfg); got.Transmission.Password != cfg.Transmission.Password {
		t.Fatal("empty password overwrote stored secret")
	}
	dto.Transmission.Password = "replacement"
	keepForever := false
	dto.Cleanup.KeepForever = &keepForever
	dto.Torrentio.Enabled = false
	got = dto.apply(cfg)
	if got.Transmission.Password != "replacement" || got.Cleanup.KeepForever || got.Torrentio.Enabled {
		t.Fatal("settings were not updated")
	}
}

func TestTorrentioProbeReadsManifest(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.Path != "/manifest.json" {
			t.Errorf("unexpected probe request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"com.stremio.torrentio","resources":["stream"]}`)
	}))
	defer server.Close()
	var h Handler
	recorder := httptest.NewRecorder()
	h.testTorrentio(recorder, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"url":"`+server.URL+`"}`)))
	if requests != 1 || !strings.Contains(recorder.Body.String(), `"ok":true`) {
		t.Fatalf("probe failed: %s", recorder.Body.String())
	}
}

func TestOmittedRetentionPreservesExistingSetting(t *testing.T) {
	cfg := config.Default()
	var dto configDTO
	if err := json.Unmarshal([]byte(`{"cleanup":{}}`), &dto); err != nil {
		t.Fatal(err)
	}
	if !dto.apply(cfg).Cleanup.KeepForever {
		t.Fatal("omitting keep_forever disabled retention")
	}
}

func TestTorrentioProbeAcceptsManifestURLAndRedactsErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/secret-token/manifest.json" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		io.WriteString(w, `{"id":"com.stremio.torrentio","resources":["stream"]}`)
	}))
	var h Handler
	probe := func(raw string) string {
		recorder := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{"url": raw})
		h.testTorrentio(recorder, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(body))))
		return recorder.Body.String()
	}
	if result := probe(server.URL + "/secret-token/manifest.json"); !strings.Contains(result, `"ok":true`) {
		t.Fatalf("manifest URL rejected: %s", result)
	}
	server.Close()
	if result := probe(server.URL + "/secret-token/manifest.json"); strings.Contains(result, "secret-token") || !strings.Contains(result, `"ok":false`) {
		t.Fatalf("unsafe error: %s", result)
	}
}

func TestRetentionHidesAutomaticRemovalCountdown(t *testing.T) {
	e := newEnv(t)
	cfg := e.config.Get()
	cfg.Cleanup.SeedTime = time.Hour
	cfg.Cleanup.TargetRatio = 1
	cfg.Cleanup.IndexerSeedTimes = map[string]time.Duration{"Tracker": 2 * time.Hour}
	if err := e.config.Update(cfg); err != nil {
		t.Fatal(err)
	}
	e.login(t)
	if err := e.store.InsertTorrent(context.Background(), store.Torrent{ID: "retained", Hash: "abc", Indexer: "Tracker", Phase: store.PhaseSelected, AddedAt: 1}); err != nil {
		t.Fatal(err)
	}
	e.fake.Put(&fake.Torrent{Hash: "abc", Progress: 1, SeedingTime: 3 * time.Hour})
	response := e.do(t, http.MethodGet, "/torrents", "")
	var items []torrentItem
	if err := json.Unmarshal(response.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].SeedTime != 0 {
		t.Fatalf("retained torrent has removal countdown: %+v", items)
	}
}

package stremio

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/kipsilabs/seedstrem/internal/downloader"
	"github.com/kipsilabs/seedstrem/internal/meta"
	"github.com/kipsilabs/seedstrem/internal/store"
	"github.com/kipsilabs/seedstrem/internal/torrents"
)

const (
	seedType           = "other"
	seedCatalogID      = "seme-seeding"
	seedIDPrefix       = "seme:seed:"
	seedPageSize       = 100 // Stremio's catalog page size.
	seedMetadataBudget = 1500 * time.Millisecond
)

var seedStoredID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var seedIMDbID = regexp.MustCompile(`^tt[0-9]+$`)
var seedAnimeID = regexp.MustCompile(`^[0-9]+$`)

type seedMetaItem struct {
	ID            string         `json:"id"`
	Type          string         `json:"type"`
	Name          string         `json:"name"`
	Poster        string         `json:"poster"`
	PosterShape   string         `json:"posterShape"`
	Description   string         `json:"description"`
	BehaviorHints map[string]any `json:"behaviorHints,omitempty"`
}

type seedCatalogResponse struct {
	Metas           []seedMetaItem `json:"metas"`
	CacheMaxAge     int            `json:"cacheMaxAge"`
	StaleRevalidate int            `json:"staleRevalidate"`
}

type seedMetaResponse struct {
	Meta            *seedMetaItem `json:"meta"`
	CacheMaxAge     int           `json:"cacheMaxAge"`
	StaleRevalidate int           `json:"staleRevalidate"`
}

type seedStreamResponse struct {
	Streams         []streamItem `json:"streams"`
	CacheMaxAge     int          `json:"cacheMaxAge"`
	StaleRevalidate int          `json:"staleRevalidate"`
}

func seedUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Download client unavailable; refresh to retry."})
}

// Catalogs and details are snapshots, not a promise of a live status view.
func seedCacheHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-cache, max-age=0, must-revalidate")
}

func decodedSeedParam(r *http.Request, key string) string {
	value := strings.TrimSuffix(chi.URLParam(r, key), ".json")
	if decoded, err := url.PathUnescape(value); err == nil {
		return decoded
	}
	return value
}

func (h *Handler) seedSnapshot(ctx context.Context, s Settings) ([]torrents.SeedTorrent, error) {
	if h.svc == nil {
		return nil, nil
	}
	// Bound an unavailable download client independently of optional metadata.
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	return h.svc.SeedSnapshot(ctx, s.ManagedLabel)
}

func (h *Handler) seedCatalog(w http.ResponseWriter, r *http.Request) {
	seedCacheHeaders(w)
	response := seedCatalogResponse{Metas: []seedMetaItem{}}
	if chi.URLParam(r, "type") != seedType || decodedSeedParam(r, "id") != seedCatalogID {
		writeJSON(w, http.StatusOK, response)
		return
	}
	skip := 0
	if extra := decodedSeedParam(r, "extra"); extra != "" {
		values, err := url.ParseQuery(extra)
		if err != nil || len(values) != 1 || len(values["skip"]) != 1 {
			writeJSON(w, http.StatusOK, response)
			return
		}
		skip, err = strconv.Atoi(values.Get("skip"))
		if err != nil || skip < 0 {
			writeJSON(w, http.StatusOK, response)
			return
		}
	}
	s := h.settings()
	snapshot, err := h.seedSnapshot(r.Context(), s)
	if err != nil {
		h.logger.Warn("stremio: seeding snapshot unavailable", "error", err)
		seedUnavailable(w)
		return
	}
	active := make([]torrents.SeedTorrent, 0, len(snapshot))
	for _, item := range snapshot {
		if item.Info.State == downloader.StateSeeding && item.Torrent.Error == "" {
			active = append(active, item)
		}
	}
	if skip < len(active) {
		end := skip + min(seedPageSize, len(active)-skip)
		response.Metas = h.seedItems(r.Context(), s, active[skip:end], time.Now().UTC())
	}
	writeJSON(w, http.StatusOK, response)
}

func seedRequestedID(typ, id string) (string, bool) {
	if typ != seedType || !strings.HasPrefix(id, seedIDPrefix) {
		return "", false
	}
	stored := strings.TrimPrefix(id, seedIDPrefix)
	return stored, seedStoredID.MatchString(stored)
}

func (h *Handler) seedMeta(w http.ResponseWriter, r *http.Request) {
	seedCacheHeaders(w)
	response := seedMetaResponse{}
	stored, ok := seedRequestedID(chi.URLParam(r, "type"), decodedSeedParam(r, "id"))
	if !ok {
		writeJSON(w, http.StatusOK, response)
		return
	}
	s := h.settings()
	snapshot, err := h.seedSnapshot(r.Context(), s)
	if err != nil {
		seedUnavailable(w)
		return
	}
	for _, item := range snapshot {
		if item.Torrent.ID == stored {
			items := h.seedItems(r.Context(), s, []torrents.SeedTorrent{item}, time.Now().UTC())
			response.Meta = &items[0]
			break
		}
	}
	writeJSON(w, http.StatusOK, response)
}

// Metadata is optional; all items retain the release identity and a valid
// local poster when remote title/poster lookup is unavailable.
func (h *Handler) seedItems(ctx context.Context, s Settings, items []torrents.SeedTorrent, at time.Time) []seedMetaItem {
	output := make([]seedMetaItem, len(items))
	ctx, cancel := context.WithTimeout(ctx, seedMetadataBudget)
	defer cancel()
	var wg sync.WaitGroup
	jobs := make(chan int)
	for n := 0; n < min(4, len(items)); n++ {
		wg.Go(func() {
			for i := range jobs {
				info := h.seedContentMeta(ctx, items[i].Torrent)
				output[i] = makeSeedMeta(s, items[i], info, at)
			}
		})
	}
	for i := range items {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return output
}

func (h *Handler) seedContentMeta(ctx context.Context, t store.Torrent) meta.Info {
	if h.meta == nil || ctx.Err() != nil {
		return meta.Info{}
	}
	var info meta.Info
	var err error
	switch t.ContentSource {
	case "tt":
		if !seedIMDbID.MatchString(t.ContentRef) {
			return meta.Info{}
		}
		typ := "movie"
		if t.Season > 0 || t.Episode > 0 {
			typ = "series"
		}
		info, err = h.meta.Meta(ctx, typ, t.ContentRef)
	case "kitsu", "mal", "anilist", "anidb":
		if !seedAnimeID.MatchString(t.ContentRef) {
			return meta.Info{}
		}
		info, err = h.meta.AnimeMeta(ctx, t.ContentSource, t.ContentRef)
	}
	if err != nil {
		return meta.Info{}
	}
	return info
}

func makeSeedMeta(s Settings, item torrents.SeedTorrent, info meta.Info, at time.Time) seedMetaItem {
	name := item.Torrent.Name
	if name == "" {
		name = item.Info.Name
	}
	if name == "" {
		name = "Managed torrent"
	}
	release := name
	if info.Name != "" {
		name = info.Name
	}
	identity := ""
	if item.Torrent.Season > 0 {
		identity = fmt.Sprintf("S%02d", item.Torrent.Season)
	}
	if item.Torrent.Episode > 0 {
		identity += fmt.Sprintf("E%02d", item.Torrent.Episode)
	}
	poster := strings.TrimRight(s.ExternalURL, "/") + "/icon-512.png"
	posterShape := "square"
	if u, err := url.Parse(info.Poster); err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" {
		poster = info.Poster
		posterShape = "poster"
	}
	description := "Release: " + release
	if identity != "" {
		description += "\nOriginal content selection: " + identity
	}
	description += "\n" + seedStats(item)
	description += "\nSnapshot: " + at.Format(time.RFC3339) + ". Refresh to update."
	return seedMetaItem{ID: seedIDPrefix + item.Torrent.ID, Type: seedType, Name: name, Poster: poster, PosterShape: posterShape, Description: description}
}

func seedStats(item torrents.SeedTorrent) string {
	status := item.Info.State
	if status == "" {
		status = "Unknown"
	}
	if item.Torrent.Error != "" {
		status = "Error"
	}
	if item.Info.State == downloader.StateSeeding && item.Torrent.Error == "" {
		status = "Seeding selected files (may be idle; does not imply the full torrent is complete)"
	}
	ratio := "n/a"
	if !item.Info.RatioUnavailable && item.Info.Ratio >= 0 && !math.IsNaN(item.Info.Ratio) && !math.IsInf(item.Info.Ratio, 0) {
		ratio = fmt.Sprintf("%.2f", item.Info.Ratio)
	}
	progress := "n/a"
	if item.Info.Progress >= 0 && item.Info.Progress <= 1 && !math.IsNaN(item.Info.Progress) {
		progress = fmt.Sprintf("%.1f%%", item.Info.Progress*100)
	}
	uploaded := "n/a"
	if item.Info.Uploaded >= 0 {
		uploaded = humanSize(item.Info.Uploaded)
	}
	return fmt.Sprintf("Status: %s\nSelected-file download progress: %s\nTorrent-wide uploaded: %s · Ratio: %s", status, progress, uploaded, ratio)
}

func (h *Handler) seedStreams(w http.ResponseWriter, r *http.Request, s Settings, typ, id string) {
	seedCacheHeaders(w)
	response := seedStreamResponse{Streams: []streamItem{}}
	stored, ok := seedRequestedID(typ, id)
	if !ok {
		writeJSON(w, http.StatusOK, response)
		return
	}
	snapshot, err := h.seedSnapshot(r.Context(), s)
	if err != nil {
		seedUnavailable(w)
		return
	}
	for _, item := range snapshot {
		if item.Torrent.ID != stored {
			continue
		}
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
		links, linkErr := h.svc.SeedPlaybackLinks(ctx, s.ManagedLabel, stored)
		cancel()
		if errors.Is(linkErr, store.ErrNotFound) {
			break
		}
		if linkErr != nil {
			seedUnavailable(w)
			return
		}
		for _, link := range links {
			if !torrents.IsVideo(link.Path) || link.Token == "" {
				continue
			}
			description := link.Path + "\n" + humanSize(link.Bytes) + "\n" + seedStats(item)
			response.Streams = append(response.Streams, streamItem{
				Name: "Sème · Existing file", Title: description, Description: description,
				URL: strings.TrimRight(s.ExternalURL, "/") + "/dl/" + url.PathEscape(link.Token),
				BehaviorHints: map[string]any{
					"notWebReady": true,
					"filename":    path.Base(strings.ReplaceAll(link.Path, `\`, "/")),
					"videoSize":   link.Bytes,
				},
			})
		}
		break
	}
	writeJSON(w, http.StatusOK, response)
}

package stremio

import (
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/kipsilabs/seedstrem/internal/meta"
	"github.com/kipsilabs/seedstrem/internal/prowlarr"
	"github.com/kipsilabs/seedstrem/internal/torrentio"
)

// Torrentio must supply the file selector on every discovery, including owned
// torrents. Reconstructing an owned stream from only the hash would lose an
// explicit fileIdx (notably for season packs with unrecognizable filenames).
func (h *Handler) torrentioStreams(w http.ResponseWriter, r *http.Request, s Settings, q meta.Query, typ, id string) {
	empty := streamResponse{Streams: []streamItem{}}
	client, err := torrentio.New(s.Torrentio.URL, s.Torrentio.Timeout)
	if err != nil {
		h.logger.Warn("stremio: invalid Torrentio configuration", "error", err)
		writeJSON(w, http.StatusOK, empty)
		return
	}
	results, err := client.Streams(r.Context(), typ, id)
	if err != nil {
		h.logger.Warn("stremio: Torrentio discovery failed", "error", err)
		writeJSON(w, http.StatusOK, empty)
		return
	}
	hashes := make([]string, 0, len(results))
	for _, res := range results {
		hashes = append(hashes, res.InfoHash)
	}
	progress := h.svc.LiveProgress(r.Context(), hashes)
	owned := h.svc.StoredByHashes(r.Context(), hashes)
	items := make([]streamItem, 0, len(results))
	// Keep Torrentio's configured ordering within the owned and fresh groups.
	sort.SliceStable(results, func(i, j int) bool {
		_, oi := owned[results[i].InfoHash]
		_, oj := owned[results[j].InfoHash]
		if oi != oj {
			return oi
		}
		return progress[results[i].InfoHash] > progress[results[j].InfoHash]
	})
	for _, res := range results {
		_, isOwned := owned[res.InfoHash]
		candidate := prowlarr.Result{Title: res.Title, InfoHash: res.InfoHash, MagnetURL: res.MagnetURL, Size: res.Size, Seeders: res.Seeders, Indexer: "Torrentio"}
		if !isOwned {
			// Upstream can omit seed/size hints; unknown values are not zero.
			filters := s.Filters
			if !res.SeedersKnown {
				filters.MinSeeders = 0
			}
			if !res.SizeKnown {
				filters.MinSizeBytes = 0
				filters.MaxSizeBytes = 0
			}
			if len(prowlarr.Filter([]prowlarr.Result{candidate}, filters)) == 0 {
				continue
			}
			if len(h.applyDiskGate([]prowlarr.Result{candidate}, s)) == 0 {
				continue
			}
		}
		item := h.toStreamItem(s.ExternalURL, q, candidate, progress[res.InfoHash])
		// The URL remains a local HTTP play action; no Torrentio infoHash or
		// direct debrid URL is exposed as the playable Stremio source.
		u, _ := url.Parse(item.URL)
		params := u.Query()
		if res.FileIndex != nil {
			params.Set("fileIdx", strconv.Itoa(*res.FileIndex))
		}
		u.RawQuery = params.Encode()
		item.URL = u.String()
		if res.Filename != "" {
			item.BehaviorHints["filename"] = res.Filename
		}
		if res.SizeKnown {
			item.BehaviorHints["videoSize"] = res.Size
		}
		// Preserve Torrentio's title, which includes language/provider hints.
		detail := res.Title
		if p := progress[res.InfoHash]; p >= 1 {
			detail += "\n✅ ready"
		} else if p > 0 {
			detail += "\n⬇ " + strconv.Itoa(int(p*100)) + "%"
		}
		detail += "\n" + aiostreamsTag("Torrentio")
		item.Title, item.Description = detail, detail
		if qualityBadge(ParseQuality(res.Title)) == "" {
			if badge := qualityBadge(ParseQuality(res.Name)); badge != "" {
				item.Name += "\n" + badge
			}
		}
		// Separate binge groups for distinct qualities of the same title.
		if q.IsSeries() || q.IsAnime() {
			item.BehaviorHints["bingeGroup"] = "seme-torrentio-" + strings.ToLower(q.Source) + "-" + q.ID + "-" + qualityBadge(ParseQuality(res.Name))
		}
		items = append(items, item)
		if s.MaxResults > 0 && len(items) >= s.MaxResults {
			break
		}
	}
	writeJSON(w, http.StatusOK, streamResponse{Streams: items})
}

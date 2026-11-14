package torrents

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/kipsilabs/seedstrem/internal/downloader"
	"github.com/kipsilabs/seedstrem/internal/store"
)

// SeedTorrent joins a stored torrent and its existing playback links with
// the download client's current state. It includes every client state;
// callers decide which states belong in their catalog.
type SeedTorrent struct {
	Torrent store.Torrent
	Info    downloader.TorrentInfo
	Links   []store.Link
}

// SeedSnapshot returns stored torrents that still carry label in the
// download client, newest first (then by ID). It only reads existing
// state: it never adopts torrents, selects files, or creates links.
// An empty label returns no torrents without contacting the client.
func (s *Service) SeedSnapshot(ctx context.Context, label string) ([]SeedTorrent, error) {
	out := make([]SeedTorrent, 0)
	if label == "" {
		return out, nil
	}

	infos, err := s.dc.TorrentsByLabel(ctx, label)
	if err != nil {
		return nil, fmt.Errorf("list seeding torrents by label: %w", err)
	}
	live := make(map[string]downloader.TorrentInfo, len(infos))
	for _, info := range infos {
		live[strings.ToLower(info.Hash)] = info
	}

	stored, err := s.store.AllTorrents(ctx)
	if err != nil {
		return nil, fmt.Errorf("list stored seeding torrents: %w", err)
	}
	for _, tor := range stored {
		info, ok := live[strings.ToLower(tor.Hash)]
		if !ok {
			continue
		}
		links, err := s.store.LinksByTorrent(ctx, tor.ID)
		if err != nil {
			return nil, fmt.Errorf("list seeding torrent links: %w", err)
		}
		out = append(out, SeedTorrent{Torrent: tor, Info: info, Links: links})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Torrent.AddedAt != out[j].Torrent.AddedAt {
			return out[i].Torrent.AddedAt > out[j].Torrent.AddedAt
		}
		return out[i].Torrent.ID < out[j].Torrent.ID
	})
	return out, nil
}

// SeedPlaybackLinks returns existing links whose exact files are complete
// in the client. Label membership is checked again for each request, and
// completed files remain playable even when they are no longer wanted.
// It never selects files or creates links.
func (s *Service) SeedPlaybackLinks(ctx context.Context, label, id string) ([]store.Link, error) {
	rows, err := s.SeedSnapshot(ctx, label)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row.Torrent.ID != id {
			continue
		}
		files, err := s.dc.Files(ctx, row.Torrent.Hash)
		if err != nil {
			return nil, fmt.Errorf("read seeding torrent files: %w", err)
		}
		complete := make(map[int]string, len(files))
		for _, file := range files {
			if file.Progress >= 1 && file.Size > 0 {
				complete[file.Index] = file.Name
			}
		}
		links := make([]store.Link, 0, len(row.Links))
		for _, link := range row.Links {
			if name, ok := complete[link.FileIndex]; ok && name == link.Path {
				links = append(links, link)
			}
		}
		return links, nil
	}
	return nil, store.ErrNotFound
}

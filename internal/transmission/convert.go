package transmission

import (
	"strings"
	"time"

	"github.com/kipsilabs/seedstrem/internal/downloader"
)

type torrent struct {
	Hash           string   `json:"hash_string"`
	Name           string   `json:"name"`
	Labels         []string `json:"labels"`
	Status         int      `json:"status"`
	Error          int      `json:"error"`
	Progress       float64  `json:"percent_done"`
	Size           int64    `json:"size_when_done"`
	Left           int64    `json:"left_until_done"`
	DlSpeed        int64    `json:"rate_download"`
	Uploaded       int64    `json:"uploaded_ever"`
	Ratio          float64  `json:"upload_ratio"`
	DownloadDir    string   `json:"download_dir"`
	SeedingSeconds int64    `json:"seconds_seeding"`
	AddedDate      int64    `json:"added_date"`
	Sequential     bool     `json:"sequential_download"`
	PieceSize      int64    `json:"piece_size"`
	PieceCount     int      `json:"piece_count"`
	Pieces         string   `json:"pieces"`
	Files          []struct {
		Name           string `json:"name"`
		Length         int64  `json:"length"`
		BytesCompleted int64  `json:"bytes_completed"`
	} `json:"files"`
	FileStats []struct {
		Wanted         bool  `json:"wanted"`
		Priority       int   `json:"priority"`
		BytesCompleted int64 `json:"bytes_completed"`
	} `json:"file_stats"`
	TrackerStats []struct {
		SeederCount int64 `json:"seeder_count"`
	} `json:"tracker_stats"`
}

func (t torrent) hasLabel(label string) bool {
	if label == "" {
		return false
	}
	for _, value := range t.Labels {
		if value == label {
			return true
		}
	}
	return false
}

func (t torrent) info() downloader.TorrentInfo {
	completed := t.Size - t.Left
	if completed < 0 {
		completed = 0
	}
	if completed > t.Size {
		completed = t.Size
	}
	var seeds int64
	// Trackers often report the same swarm. Taking the maximum avoids
	// counting all seeds once per tracker; -1 means unknown.
	for _, tracker := range t.TrackerStats {
		if tracker.SeederCount > seeds {
			seeds = tracker.SeederCount
		}
	}
	ratio := t.Ratio
	if ratio < 0 {
		ratio = 0
	} // Transmission uses negative sentinels.
	info := downloader.TorrentInfo{Hash: strings.ToLower(t.Hash), Name: t.Name, State: normalizeState(t.Status, t.Error),
		Progress: t.Progress, Size: t.Size, Completed: completed, DlSpeed: t.DlSpeed, NumSeeds: seeds, Uploaded: t.Uploaded,
		Ratio: ratio, SavePath: t.DownloadDir, SeedingTime: time.Duration(t.SeedingSeconds) * time.Second, SequentialDownload: t.Sequential}
	info.RatioUnavailable = t.Ratio < 0
	if t.AddedDate > 0 {
		info.AddedAt = time.Unix(t.AddedDate, 0)
	}
	// RPC download_dir is the final destination. The shared resolver uses
	// IncompleteFileHints for the session's separate folder and .part suffix.
	return info
}

func (t torrent) files() []downloader.FileInfo {
	out := make([]downloader.FileInfo, len(t.Files))
	for i, f := range t.Files {
		completed, priority := f.BytesCompleted, 4
		if i < len(t.FileStats) {
			s := t.FileStats[i]
			completed = s.BytesCompleted
			if !s.Wanted {
				priority = 0
			} else if s.Priority < 0 {
				priority = 1
			} else if s.Priority > 0 {
				priority = 7
			}
		}
		progress := float64(0)
		if f.Length == 0 {
			progress = 1
		} else {
			progress = float64(completed) / float64(f.Length)
		}
		if progress < 0 {
			progress = 0
		}
		if progress > 1 {
			progress = 1
		}
		out[i] = downloader.FileInfo{Index: i, Name: f.Name, Size: f.Length, Progress: progress, Priority: priority}
	}
	return out
}

func normalizeState(status, rpcError int) string {
	if rpcError != 0 {
		return downloader.StateError
	}
	switch status {
	case 0:
		return downloader.StatePaused
	case 1, 2:
		return downloader.StateChecking
	case 3, 5:
		return downloader.StateQueued
	case 6:
		return downloader.StateSeeding
	default:
		return downloader.StateDownloading
	}
}

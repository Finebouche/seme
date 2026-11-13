package cleanup

import (
	"context"
	"testing"
	"time"

	"github.com/kipsilabs/seedstrem/internal/downloader"
	"github.com/kipsilabs/seedstrem/internal/downloader/fake"
	"github.com/kipsilabs/seedstrem/internal/store"
)

func TestKeepForeverOverridesEveryRemovalTrigger(t *testing.T) {
	c, dc, db, _ := newCleanup(t, time.Hour)
	ctx := context.Background()
	tor := store.Torrent{ID: "retained", Hash: testHash, Indexer: "Torrentio"}
	if err := db.InsertTorrent(ctx, tor); err != nil {
		t.Fatal(err)
	}
	info := downloader.TorrentInfo{Hash: testHash, Progress: 1, SeedingTime: 24 * time.Hour, Ratio: 10}
	dc.Put(&fake.Torrent{Hash: testHash, Progress: 1, SeedingTime: 24 * time.Hour, Ratio: 10})
	settings := Settings{KeepForever: true, SeedTime: time.Hour, TargetRatio: 1, IndexerSeedTimes: map[string]time.Duration{"Torrentio": time.Minute}}
	c.settings = func() Settings { return settings }
	if got := selectRemovals([]store.Torrent{tor}, map[string]downloader.TorrentInfo{testHash: info}, settings); len(got) != 0 {
		t.Fatal("retention selected removal")
	}
	if err := c.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TorrentByID(ctx, tor.ID); err != nil {
		t.Fatal("retained torrent disappeared", err)
	}
	if dc.Get(testHash) == nil {
		t.Fatal("retained torrent removed from client")
	}
}

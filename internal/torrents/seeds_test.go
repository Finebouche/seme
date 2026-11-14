package torrents

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/kipsilabs/seedstrem/internal/downloader"
	"github.com/kipsilabs/seedstrem/internal/downloader/fake"
	"github.com/kipsilabs/seedstrem/internal/store"
)

func TestSeedSnapshotIntersectionAndReadOnly(t *testing.T) {
	svc, dc, db := newService(t)
	ctx := context.Background()
	rows := []store.Torrent{
		{ID: "older", Hash: strings.ToUpper(testHash), AddedAt: 10, Phase: store.PhaseSelected},
		{ID: "new-b", Hash: "bbbb", AddedAt: 20, Phase: store.PhaseAdded},
		{ID: "new-a", Hash: "aaaa", AddedAt: 20, Phase: store.PhaseSelected, Origin: store.OriginAdopted},
		{ID: "missing", Hash: "cccc", AddedAt: 30},
		{ID: "foreign", Hash: "dddd", AddedAt: 40},
		// Native rows must lose catalog visibility when their label is removed.
		{ID: "label-removed", Hash: "eeee", AddedAt: 50, Origin: store.OriginNative},
	}
	for _, tor := range rows {
		if err := db.InsertTorrent(ctx, tor); err != nil {
			t.Fatal(err)
		}
	}
	links := []store.Link{
		{Token: "second", TorrentID: "older", FileIndex: 3, Path: "second.mkv", Bytes: 20},
		{Token: "first", TorrentID: "older", FileIndex: 1, Path: "first.mkv", Bytes: 10},
	}
	if err := db.InsertLinks(ctx, links); err != nil {
		t.Fatal(err)
	}
	dc.Put(&fake.Torrent{Hash: testHash, Category: "seedstrem", State: downloader.StateSeeding,
		Progress: 1, Uploaded: 100, Ratio: 1.5, Files: []fake.File{{Name: "unchanged.mkv", Priority: 0}}})
	dc.Put(&fake.Torrent{Hash: "AAAA", Category: "seedstrem", State: downloader.StatePaused, Progress: 1, Stopped: true})
	dc.Put(&fake.Torrent{Hash: "bbbb", Category: "seedstrem", State: downloader.StateDownloading, Progress: .5})
	dc.Put(&fake.Torrent{Hash: "dddd", Category: "another-app", State: downloader.StateSeeding})
	dc.Put(&fake.Torrent{Hash: "eeee", Category: "seedstrem", State: downloader.StateSeeding})
	dc.Update("eeee", func(tor *fake.Torrent) { tor.Category = "" })
	// A labeled torrent without a store row must never be adopted here.
	dc.Put(&fake.Torrent{Hash: "ffff", Category: "seedstrem", State: downloader.StateSeeding})
	beforeRows, err := db.AllTorrents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	beforeTorrent := dc.Get(testHash)

	got, err := svc.SeedSnapshot(ctx, "seedstrem")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, row := range got {
		ids = append(ids, row.Torrent.ID)
	}
	if want := []string{"new-a", "new-b", "older"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("IDs = %v, want %v", ids, want)
	}
	if got[0].Info.State != downloader.StatePaused || got[1].Info.State != downloader.StateDownloading {
		t.Errorf("nonseeding states lost: %+v", got)
	}
	if got[2].Info.Uploaded != 100 || got[2].Info.Ratio != 1.5 || got[2].Info.State != downloader.StateSeeding {
		t.Errorf("live metrics = %+v", got[2].Info)
	}
	if want := []store.Link{links[1], links[0]}; !reflect.DeepEqual(got[2].Links, want) {
		t.Errorf("existing links = %+v, want %+v", got[2].Links, want)
	}
	if len(got[0].Links) != 0 || len(got[1].Links) != 0 {
		t.Errorf("links created for unlinked torrents: %+v", got)
	}
	if after := dc.Get(testHash); !reflect.DeepEqual(beforeTorrent, after) {
		t.Errorf("client torrent changed: before %+v, after %+v", beforeTorrent, after)
	}

	dc.Update(testHash, func(tor *fake.Torrent) {
		tor.Uploaded, tor.Ratio, tor.State = 350, 3.5, downloader.StateQueued
	})
	got, err = svc.SeedSnapshot(ctx, "seedstrem")
	if err != nil {
		t.Fatal(err)
	}
	if got[2].Info.Uploaded != 350 || got[2].Info.Ratio != 3.5 || got[2].Info.State != downloader.StateQueued {
		t.Errorf("snapshot did not refresh live metrics: %+v", got[2].Info)
	}
	dc.Remove(testHash)
	got, err = svc.SeedSnapshot(ctx, "seedstrem")
	if err != nil || len(got) != 2 {
		t.Fatalf("removed torrent remains: %+v, error %v", got, err)
	}
	afterRows, err := db.AllTorrents(ctx)
	if err != nil || !reflect.DeepEqual(beforeRows, afterRows) {
		t.Errorf("stored rows changed: %+v, error %v", afterRows, err)
	}
	afterLinks, err := db.LinksByTorrent(ctx, "older")
	if err != nil || !reflect.DeepEqual(afterLinks, []store.Link{links[1], links[0]}) {
		t.Errorf("stored links changed: %+v, error %v", afterLinks, err)
	}
	if want := []string{"torrentsByLabel label=seedstrem", "torrentsByLabel label=seedstrem", "torrentsByLabel label=seedstrem"}; !reflect.DeepEqual(dc.Calls(), want) {
		t.Errorf("unexpected client calls (snapshot must not mutate): %v", dc.Calls())
	}
}

func TestSeedSnapshotEmptyAndUnknownLabel(t *testing.T) {
	svc, dc, _ := newService(t)
	dc.Put(&fake.Torrent{Hash: testHash, Category: "seedstrem", State: downloader.StateSeeding})
	got, err := svc.SeedSnapshot(context.Background(), "")
	if err != nil || len(got) != 0 || len(dc.Calls()) != 0 {
		t.Fatalf("empty label: rows %v, error %v, calls %v", got, err, dc.Calls())
	}
	got, err = svc.SeedSnapshot(context.Background(), "unknown")
	if err != nil || len(got) != 0 {
		t.Fatalf("unknown label: rows %v, error %v", got, err)
	}
}

func TestSeedSnapshotClientErrors(t *testing.T) {
	for _, want := range []error{downloader.ErrNotSupported, errors.New("client unavailable")} {
		t.Run(want.Error(), func(t *testing.T) {
			svc, dc, _ := newService(t)
			dc.SetTorrentsByLabelErr(want)
			got, err := svc.SeedSnapshot(context.Background(), "seedstrem")
			if !errors.Is(err, want) || len(got) != 0 {
				t.Fatalf("rows %v, error %v, want %v", got, err, want)
			}
			if calls := dc.Calls(); len(calls) != 1 || calls[0] != "torrentsByLabel label=seedstrem" {
				t.Errorf("unexpected client calls: %v", calls)
			}
		})
	}
}

func TestSeedSnapshotStoreError(t *testing.T) {
	svc, _, db := newService(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := svc.SeedSnapshot(context.Background(), "seedstrem")
	if err == nil || len(got) != 0 {
		t.Fatalf("closed store: rows %v, error %v", got, err)
	}
}

type seedPlaybackClient struct {
	downloader.Client
	filesCalls int
	filesErr   error
}

func (c *seedPlaybackClient) Files(ctx context.Context, hash string) ([]downloader.FileInfo, error) {
	c.filesCalls++
	if c.filesErr != nil {
		return nil, c.filesErr
	}
	return c.Client.Files(ctx, hash)
}

func TestSeedPlaybackLinksOnlyCompleteExistingFiles(t *testing.T) {
	svc, dc, db := newService(t)
	ctx := context.Background()
	if err := db.InsertTorrent(ctx, store.Torrent{ID: "show", Hash: testHash}); err != nil {
		t.Fatal(err)
	}
	links := []store.Link{
		{Token: "historical", TorrentID: "show", FileIndex: 0, Path: "partial.mkv", Bytes: 100},
		{Token: "complete-unwanted", TorrentID: "show", FileIndex: 1, Path: "complete.mkv", Bytes: 100},
		{Token: "empty", TorrentID: "show", FileIndex: 2, Path: "empty.mkv"},
		{Token: "changed-path", TorrentID: "show", FileIndex: 3, Path: "old.mkv", Bytes: 100},
		{Token: "missing-index", TorrentID: "show", FileIndex: 9, Path: "missing.mkv", Bytes: 100},
	}
	if err := db.InsertLinks(ctx, links); err != nil {
		t.Fatal(err)
	}
	dc.Put(&fake.Torrent{Hash: testHash, Category: "seedstrem", State: downloader.StateSeeding, Progress: 1,
		Files: []fake.File{
			{Name: "partial.mkv", Size: 100, Progress: .25, Priority: 0},
			{Name: "complete.mkv", Size: 100, Progress: 1, Priority: 0},
			{Name: "empty.mkv", Size: 0, Progress: 1, Priority: 1},
			{Name: "new.mkv", Size: 100, Progress: 1, Priority: 1},
			{Name: "unlinked.mkv", Size: 100, Progress: 1, Priority: 1},
		}})
	before := dc.Get(testHash)
	client := &seedPlaybackClient{Client: dc}
	svc.dc = client
	got, err := svc.SeedPlaybackLinks(ctx, "seedstrem", "show")
	if err != nil || !reflect.DeepEqual(got, []store.Link{links[1]}) {
		t.Fatalf("playback links = %+v, error %v, want complete unwanted file", got, err)
	}
	if client.filesCalls != 1 {
		t.Errorf("Files calls = %d, want 1", client.filesCalls)
	}
	if after := dc.Get(testHash); !reflect.DeepEqual(before, after) {
		t.Errorf("client torrent changed: before %+v, after %+v", before, after)
	}
	if calls := dc.Calls(); !reflect.DeepEqual(calls, []string{"torrentsByLabel label=seedstrem"}) {
		t.Errorf("unexpected client mutations: %v", calls)
	}
	afterLinks, err := db.LinksByTorrent(ctx, "show")
	if err != nil || !reflect.DeepEqual(afterLinks, links) {
		t.Errorf("stored links changed: %+v, error %v", afterLinks, err)
	}
}

func TestSeedPlaybackLinksRequiresCurrentMembership(t *testing.T) {
	svc, dc, db := newService(t)
	ctx := context.Background()
	if err := db.InsertTorrent(ctx, store.Torrent{ID: "stored", Hash: testHash}); err != nil {
		t.Fatal(err)
	}
	dc.Put(&fake.Torrent{Hash: testHash, Category: "seedstrem"})
	dc.Put(&fake.Torrent{Hash: "ffff", Category: "seedstrem"})
	client := &seedPlaybackClient{Client: dc}
	svc.dc = client
	for _, tc := range []struct{ label, id string }{
		{"", "stored"},
		{"unknown", "stored"},
		{"seedstrem", "unknown"},
		{"seedstrem", "ffff"},
	} {
		got, err := svc.SeedPlaybackLinks(ctx, tc.label, tc.id)
		if !errors.Is(err, store.ErrNotFound) || len(got) != 0 {
			t.Errorf("label %q, id %q: links %+v, error %v", tc.label, tc.id, got, err)
		}
	}
	dc.Update(testHash, func(tor *fake.Torrent) { tor.Category = "" })
	got, err := svc.SeedPlaybackLinks(ctx, "seedstrem", "stored")
	if !errors.Is(err, store.ErrNotFound) || len(got) != 0 {
		t.Errorf("removed label: links %+v, error %v", got, err)
	}
	if client.filesCalls != 0 {
		t.Errorf("Files called without current store/label membership: %d", client.filesCalls)
	}
	for _, call := range dc.Calls() {
		if !strings.HasPrefix(call, "torrentsByLabel label=") {
			t.Errorf("unexpected client mutation: %s", call)
		}
	}
}

func TestSeedPlaybackLinksFileError(t *testing.T) {
	svc, dc, db := newService(t)
	ctx := context.Background()
	if err := db.InsertTorrent(ctx, store.Torrent{ID: "stored", Hash: testHash}); err != nil {
		t.Fatal(err)
	}
	dc.Put(&fake.Torrent{Hash: testHash, Category: "seedstrem"})
	want := errors.New("files unavailable")
	svc.dc = &seedPlaybackClient{Client: dc, filesErr: want}
	got, err := svc.SeedPlaybackLinks(ctx, "seedstrem", "stored")
	if !errors.Is(err, want) || len(got) != 0 {
		t.Fatalf("links %+v, error %v, want %v", got, err, want)
	}
}

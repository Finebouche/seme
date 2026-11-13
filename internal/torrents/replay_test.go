package torrents

import (
	"context"
	"testing"

	"github.com/kipsilabs/seedstrem/internal/downloader"
	"github.com/kipsilabs/seedstrem/internal/downloader/fake"
)

func TestReplayEpisodeRestoresWantedFileAndResumes(t *testing.T) {
	svc, dc, _ := newService(t)
	dc.Put(&fake.Torrent{Hash: testHash, State: downloader.StatePaused, Files: []fake.File{{Name: "first.mkv", Size: 100}, {Name: "second.mkv", Size: 200}}})
	ctx := context.Background()
	first, second := 0, 1
	link, err := svc.Resolve(ctx, testMagnet("Season"), nil, Selector{FileIndex: &first})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Resolve(ctx, testMagnet("Season"), nil, Selector{FileIndex: &second}); err != nil {
		t.Fatal(err)
	}
	if dc.Get(testHash).Files[0].Priority != 0 {
		t.Fatal("first episode should have been deselected")
	}
	dc.Update(testHash, func(t *fake.Torrent) { t.State = downloader.StatePaused; t.Stopped = true })
	replay, err := svc.Resolve(ctx, testMagnet("Season"), nil, Selector{FileIndex: &first})
	if err != nil {
		t.Fatal(err)
	}
	if replay.Token != link.Token {
		t.Fatal("replay must reuse streaming link")
	}
	live := dc.Get(testHash)
	if live.Files[0].Priority == 0 || live.Files[1].Priority != 0 {
		t.Fatalf("replay priorities: %+v", live.Files)
	}
	if live.Stopped || live.State == downloader.StatePaused {
		t.Fatal("replay did not resume download")
	}
}

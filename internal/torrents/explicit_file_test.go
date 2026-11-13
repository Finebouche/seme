package torrents

import (
	"errors"
	"testing"

	"github.com/kipsilabs/seedstrem/internal/downloader"
)

func TestExplicitFileSelection(t *testing.T) {
	files := []downloader.FileInfo{{Index: 0, Name: "unconventional-name.mkv", Size: 10}, {Index: 1, Name: "Series.S01E02.mkv", Size: 100}, {Index: 2, Name: "readme.txt", Size: 1}}
	for _, tc := range []struct {
		name    string
		index   int
		wantErr bool
	}{{"zero", 0, false}, {"other video", 1, false}, {"non video", 2, true}, {"negative", -1, true}, {"absent", 3, true}} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := PickFile(files, Selector{FileIndex: &tc.index, IsSeries: true, Season: 1, Episode: 2})
			if tc.wantErr {
				if !errors.Is(err, ErrNoFileMatch) {
					t.Fatalf("error=%v", err)
				}
				return
			}
			if err != nil || got != tc.index {
				t.Fatalf("got %d, %v", got, err)
			}
		})
	}
}

package stream

import "testing"

func TestKeepForeverPreservesAbandonedDownload(t *testing.T) {
	h, tor, dc := newAbandonEnv(t, 0.01, 0.5)
	h.settings = func() Settings { return Settings{KeepForever: true, MinProgressForCancel: 0.5} }
	h.checkAbandoned(tor)
	if dc.Get(testHash) == nil {
		t.Fatal("retained download removed after playback closed")
	}
}

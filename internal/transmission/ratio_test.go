package transmission

import "testing"

func TestRatioSentinelIsNotMeasuredZero(t *testing.T) {
	for _, ratio := range []float64{-2, -1, 0, 1.25} {
		got := (torrent{Ratio: ratio}).info()
		if got.RatioUnavailable != (ratio < 0) {
			t.Fatalf("ratio %v: unavailable=%v", ratio, got.RatioUnavailable)
		}
		if ratio >= 0 && got.Ratio != ratio {
			t.Fatalf("measured ratio changed: %v -> %v", ratio, got.Ratio)
		}
	}
}

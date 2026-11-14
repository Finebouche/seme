package admin

import (
	"encoding/json"
	"testing"

	"github.com/kipsilabs/seedstrem/internal/config"
)

func TestDesktopSetupDTORoundTrip(t *testing.T) {
	cfg := config.Default()
	for _, complete := range []bool{false, true} {
		cfg.Desktop.SetupComplete = complete
		dto := toDTO(cfg)
		if dto.Desktop.SetupComplete == nil || *dto.Desktop.SetupComplete != complete {
			t.Fatal("setup completion missing from config response")
		}
		if got := dto.apply(cfg); got.Desktop.SetupComplete != complete {
			t.Fatal("setup completion lost in round trip")
		}
	}
	var dto configDTO
	if err := json.Unmarshal([]byte(`{"desktop":{"setup_complete":false}}`), &dto); err != nil {
		t.Fatal(err)
	}
	if dto.apply(cfg).Desktop.SetupComplete {
		t.Fatal("explicit setup completion reset ignored")
	}
	var legacy configDTO
	if !legacy.apply(cfg).Desktop.SetupComplete {
		t.Fatal("legacy client reset desktop setup completion")
	}
}

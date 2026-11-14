package desktop

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/kipsilabs/seedstrem/internal/config"
)

func TestPrepareIsolatedDefaultsAndPermissions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SEME_SERVER_LISTEN", "0.0.0.0:8080")
	t.Setenv("SEME_TRANSMISSION_PASSWORD", "shell-password")
	globalPath := filepath.Join(home, "config.yaml")
	globalConfig := []byte("server: unrelated configuration\n")
	if err := os.WriteFile(globalPath, globalConfig, 0o644); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(t.TempDir(), "application", "Seme")
	path, err := Prepare(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Listen != Listen || cfg.Server.ExternalURL != URL || cfg.Server.AdminPassword == "" {
		t.Fatalf("incorrect desktop server settings: %+v", cfg.Server)
	}
	if cfg.Storage.Database != filepath.Join(dataDir, "seme.db") || !filepath.IsAbs(cfg.Storage.Database) {
		t.Fatalf("database outside desktop data dir: %q", cfg.Storage.Database)
	}
	if cfg.Downloader.Type != config.DownloaderTransmission || cfg.Transmission.URL != "http://127.0.0.1:9091/transmission/rpc" || cfg.Transmission.Label != "seme" || cfg.Transmission.DownloadDir != "" || cfg.Transmission.Password != "" {
		t.Fatalf("incorrect Transmission defaults: %+v", cfg.Transmission)
	}
	if !cfg.Torrentio.Enabled || cfg.Seeding.Full || !cfg.Cleanup.KeepForever || cfg.Storage.DeleteFilesOnRemove || cfg.Desktop.SetupComplete {
		t.Fatal("incorrect first-run defaults")
	}
	wantDownloads := filepath.Join(home, "Downloads", "Seme")
	if !reflect.DeepEqual(cfg.Paths.Mappings, []config.Mapping{{Remote: wantDownloads, Local: wantDownloads}}) {
		t.Fatalf("non-native mapping: %+v", cfg.Paths.Mappings)
	}
	if _, err := os.Stat(wantDownloads); !os.IsNotExist(err) {
		t.Fatalf("Prepare created a download directory: %v", err)
	}
	if got, err := os.ReadFile(globalPath); err != nil || !reflect.DeepEqual(got, globalConfig) {
		t.Fatal("unrelated config changed")
	}
	assertPermissions(t, dataDir, 0o700)
	assertPermissions(t, path, 0o600)
}

func TestPrepareReopenPreservesChoices(t *testing.T) {
	dataDir := t.TempDir()
	path, err := Prepare(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Desktop.SetupComplete = true
	cfg.Transmission.Username = "alice"
	cfg.Transmission.Password = "private-rpc-password"
	cfg.Transmission.DownloadDir = filepath.Join(dataDir, "chosen-downloads")
	cfg.Paths.Mappings = []config.Mapping{{Remote: cfg.Transmission.DownloadDir, Local: cfg.Transmission.DownloadDir}}
	cfg.Cleanup.KeepForever = false
	cfg.Seeding.Full = true
	want := cfg
	cfg.Server.Listen = ":9099"
	cfg.Server.ExternalURL = "https://example.com"
	cfg.Storage.Database = "/unrelated/data.db"
	if err := config.Save(cfg, path); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SEME_SERVER_ADMIN_PASSWORD", "replace-password")
	if reopened, err := Prepare(dataDir); err != nil || reopened != path {
		t.Fatalf("reopen: %q, %v", reopened, err)
	}
	got, err := config.LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("reopening changed credentials or saved choices, or failed to enforce isolation")
	}
}

func TestPrepareUsesUserConfigDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config-home"))
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	path, err := Prepare("")
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(base, "Seme", "config.yaml") {
		t.Fatalf("wrong default desktop data directory: %q", path)
	}
}

func TestWriteReadyPrivateJSONAndAtomicReplacement(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "ready.json")
	cfg := config.Default()
	cfg.Server.Listen, cfg.Server.ExternalURL, cfg.Server.AdminPassword = Listen, URL, "private-password"
	for range 2 {
		if err := WriteReady(path, cfg); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]string
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, map[string]string{"url": URL, "admin_password": cfg.Server.AdminPassword}) {
			t.Fatalf("incorrect ready file: %+v", got)
		}
		assertPermissions(t, path, 0o600)
		cfg.Server.AdminPassword = "replacement-password"
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 {
		t.Fatal("temporary readiness file leaked")
	}
}

func TestWriteReadyRejectsPublicDirectoryAndServer(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Server.Listen, cfg.Server.ExternalURL, cfg.Server.AdminPassword = Listen, URL, "secret"
	if err := WriteReady(filepath.Join(dir, "ready.json"), cfg); err == nil {
		t.Fatal("accepted public ready directory")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg.Server.Listen = ":17880"
	if err := WriteReady(filepath.Join(dir, "ready.json"), cfg); err == nil {
		t.Fatal("accepted public server")
	}
}

func TestPrepareRejectsSymlinkConfig(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "unrelated.yaml")
	if err := os.WriteFile(target, []byte("unrelated"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "config.yaml")); err != nil {
		t.Fatal(err)
	}
	if _, err := Prepare(dir); err == nil {
		t.Fatal("accepted symlink config")
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "unrelated" {
		t.Fatal("modified symlink target")
	}
}

func assertPermissions(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode %o, want %o", path, got, want)
	}
}

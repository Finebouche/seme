// Package desktop prepares isolated, private state for the native Sème app.
package desktop

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kipsilabs/seedstrem/internal/config"
)

const (
	Listen = "127.0.0.1:17880"
	URL    = "http://127.0.0.1:17880"
)

// Prepare creates or reopens the desktop's private config. An empty dataDir
// selects Seme within the OS user's application config directory. No server
// config, environment overrides, or download-client settings are imported.
func Prepare(dataDir string) (string, error) {
	if dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("locate application support directory: %w", err)
		}
		dataDir = filepath.Join(base, "Seme")
	}
	dataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return "", fmt.Errorf("resolve desktop data directory: %w", err)
	}
	if err := rejectSymlink(dataDir); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", fmt.Errorf("create desktop data directory: %w", err)
	}
	if err := os.Chmod(dataDir, 0o700); err != nil {
		return "", fmt.Errorf("secure desktop data directory: %w", err)
	}
	path := filepath.Join(dataDir, "config.yaml")
	if err := rejectSymlink(path); err != nil {
		return "", err
	}

	var cfg config.Config
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		cfg = config.Default()
		cfg.Downloader.Type = config.DownloaderTransmission
		cfg.Transmission.URL = "http://127.0.0.1:9091/transmission/rpc"
		cfg.Transmission.Label = "seme"
		cfg.Torrentio.Enabled = true
		cfg.Seeding.Full = false
		cfg.Cleanup.KeepForever = true
		cfg.Storage.DeleteFilesOnRemove = false
		// The setup wizard must obtain an explicit folder choice before
		// Transmission is given a download destination. The identity mapping
		// is only a suggested local root; this does not create the directory.
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("locate download directory: %w", err)
		}
		downloads := filepath.Join(home, "Downloads", "Seme")
		cfg.Paths.Mappings = []config.Mapping{{Remote: downloads, Local: downloads}}
	} else if err != nil {
		return "", fmt.Errorf("inspect desktop config: %w", err)
	} else {
		cfg, err = config.LoadFile(path)
		if err != nil {
			return "", fmt.Errorf("load desktop config: %w", err)
		}
	}
	// The native application always binds a known loopback address. Resetting
	// these values also repairs settings saved through the general admin UI.
	cfg.Server.Listen = Listen
	cfg.Server.ExternalURL = URL
	cfg.Storage.Database = filepath.Join(dataDir, "seme.db")
	if _, err := config.EnsureSecrets(&cfg); err != nil {
		return "", err
	}
	if err := config.Save(cfg, path); err != nil {
		return "", fmt.Errorf("save desktop config: %w", err)
	}
	return path, nil
}

// WriteReady atomically hands the authenticated local server URL to the native
// launcher. Call only after the HTTP listener has been successfully acquired.
// The launcher must supply an absolute path within its private temp directory.
func WriteReady(path string, cfg config.Config) error {
	if !filepath.IsAbs(path) || filepath.Base(path) == "." {
		return errors.New("desktop ready path must be an absolute file path")
	}
	if cfg.Server.Listen != Listen || cfg.Server.ExternalURL != URL || cfg.Server.AdminPassword == "" {
		return errors.New("desktop readiness requires an authenticated loopback server")
	}
	dir := filepath.Dir(path)
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("inspect desktop ready directory: %w", err)
	}
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("desktop ready directory must be private")
	}
	if err := rejectSymlink(path); err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		URL           string `json:"url"`
		AdminPassword string `json:"admin_password"`
	}{URL: cfg.Server.ExternalURL, AdminPassword: cfg.Server.AdminPassword})
	if err != nil {
		return fmt.Errorf("encode desktop readiness: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".ready-*.json")
	if err != nil {
		return fmt.Errorf("create desktop readiness: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return fmt.Errorf("write desktop readiness: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close desktop readiness: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("publish desktop readiness: %w", err)
	}
	return nil
}

func rejectSymlink(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect desktop path: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("desktop state path must not be a symlink")
	}
	return nil
}

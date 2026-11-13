package config

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSemeDefaultsAndRoundTrip(t *testing.T) {
	cfg := Default()
	if cfg.Downloader.Type != DownloaderTransmission || cfg.ClientLabel() != "seme" || !cfg.Torrentio.Enabled || cfg.Torrentio.Timeout != 20*time.Second {
		t.Fatalf("unexpected client/provider defaults: %+v", cfg)
	}
	if !cfg.Cleanup.KeepForever || cfg.Storage.DeleteFilesOnRemove || cfg.Cleanup.SeedTime != 0 || cfg.Cleanup.MinProgressForCancel != 0 {
		t.Fatal("unsafe retention defaults")
	}
	cfg.Transmission.Username = "user"
	cfg.Transmission.Password = "secret"
	cfg.Transmission.DownloadDir = "/downloads"
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := Save(cfg, path); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Transmission != cfg.Transmission || got.Torrentio != cfg.Torrentio || got.Cleanup.KeepForever != cfg.Cleanup.KeepForever {
		t.Fatal("new settings lost during YAML round trip")
	}
}

func TestSemeEnvironmentAliasesTakePrecedence(t *testing.T) {
	cfg := Default()
	env := map[string]string{
		"SEEDSTREM_TRANSMISSION_URL":          "http://legacy:9091/transmission/rpc",
		"SEME_TRANSMISSION_URL":               "http://preferred:9091/transmission/rpc",
		"SEME_TRANSMISSION_PASSWORD":          "secret",
		"SEME_TORRENTIO_TIMEOUT":              "12s",
		"SEME_TORRENTIO_ENABLED":              "false",
		"SEME_CLEANUP_KEEP_FOREVER":           "false",
		"SEME_STORAGE_DELETE_FILES_ON_REMOVE": "true",
		"SEME_RSS_INTERVAL":                   "30m",
	}
	applyEnv(&cfg, func(k string) string { return env[k] })
	if cfg.Transmission.URL != env["SEME_TRANSMISSION_URL"] || cfg.Transmission.Password != "secret" || cfg.Torrentio.Timeout != 12*time.Second || cfg.Torrentio.Enabled || cfg.Cleanup.KeepForever || !cfg.Storage.DeleteFilesOnRemove || cfg.RSS.Interval != 30*time.Minute {
		t.Fatal("SEME aliases not applied")
	}
}

func TestSemeProviderAndTransmissionValidation(t *testing.T) {
	cases := []struct {
		name, field string
		change      func(*Config)
	}{
		{"invalid transmission", "transmission.url", func(c *Config) { c.Transmission.URL = "http://" }},
		{"invalid torrentio", "torrentio.url", func(c *Config) { c.Torrentio.URL = "ftp://torrentio.example" }},
		{"missing provider", "enable Torrentio", func(c *Config) { c.Torrentio.Enabled = false }},
		{"invalid timeout", "torrentio.timeout", func(c *Config) { c.Torrentio.Timeout = 0 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Default()
			tc.change(&cfg)
			if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("wanted %s error, got %v", tc.field, err)
			}
		})
	}
	cfg := Default()
	cfg.Torrentio.Enabled = false
	cfg.Prowlarr.URL = "http://prowlarr:9696"
	cfg.Prowlarr.APIKey = "secret"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Prowlarr-only config: %v", err)
	}
}

func TestTransmissionLabelValidation(t *testing.T) {
	for _, label := range []string{"", " ", "one,two"} {
		cfg := Default()
		cfg.Transmission.Label = label
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "transmission.label") {
			t.Fatalf("label %q: %v", label, err)
		}
	}
}

func TestTorrentioURLMatchesProviderValidation(t *testing.T) {
	for _, raw := range []string{"https://user:secret@example.com", "https://example.com?token=secret", "https://example.com#secret"} {
		cfg := Default()
		cfg.Torrentio.URL = raw
		if err := cfg.Validate(); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("URL not rejected safely: %v", err)
		}
	}
	cfg := Default()
	cfg.Torrentio.URL = "stremio://torrentio.strem.fun/providers=nyaasi/manifest.json"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Stremio install URL rejected: %v", err)
	}
}

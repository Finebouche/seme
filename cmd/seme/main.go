// Command seme runs the Sème Stremio addon, derived from Seedstrem.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kipsilabs/seedstrem/internal/admin"
	"github.com/kipsilabs/seedstrem/internal/adopt"
	"github.com/kipsilabs/seedstrem/internal/cleanup"
	"github.com/kipsilabs/seedstrem/internal/config"
	"github.com/kipsilabs/seedstrem/internal/deluge"
	"github.com/kipsilabs/seedstrem/internal/desktop"
	"github.com/kipsilabs/seedstrem/internal/downloader"
	"github.com/kipsilabs/seedstrem/internal/meta"
	"github.com/kipsilabs/seedstrem/internal/playsession"
	"github.com/kipsilabs/seedstrem/internal/prowlarr"
	"github.com/kipsilabs/seedstrem/internal/qbit"
	"github.com/kipsilabs/seedstrem/internal/rss"
	"github.com/kipsilabs/seedstrem/internal/server"
	"github.com/kipsilabs/seedstrem/internal/store"
	"github.com/kipsilabs/seedstrem/internal/stream"
	"github.com/kipsilabs/seedstrem/internal/stremio"
	"github.com/kipsilabs/seedstrem/internal/syncer"
	"github.com/kipsilabs/seedstrem/internal/torrents"
	"github.com/kipsilabs/seedstrem/internal/transmission"
)

var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Sème:", err)
		os.Exit(1)
	}
}

func run() error {
	parentPID := os.Getppid()
	configPath := flag.String("config", defaultConfigPath(), "path to config.yaml")
	healthcheck := flag.Bool("healthcheck", false, "probe the local /api/health endpoint and exit (for Docker HEALTHCHECK)")
	showVersion := flag.Bool("version", false, "print version and exit")
	desktopMode := flag.Bool("desktop", false, "run the local macOS companion service")
	desktopDataDir := flag.String("desktop-data-dir", "", "override the companion application's data directory")
	desktopReady := flag.String("desktop-ready", "", "private readiness file for the companion application")
	flag.Parse()

	if *showVersion {
		fmt.Println("Sème", version)
		return nil
	}

	if !*desktopMode && (*desktopDataDir != "" || *desktopReady != "") {
		return errors.New("desktop options require --desktop")
	}
	loadConfig := config.Load
	if *desktopMode {
		path, err := desktop.Prepare(*desktopDataDir)
		if err != nil {
			return err
		}
		*configPath = path
		// The application owns its local endpoint and isolated storage;
		// shell/container overrides must not redirect it to another instance.
		loadConfig = config.LoadFile
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if *desktopMode {
		// Enforce the desktop boundary at the point of use as well as on disk.
		cfg.Server.Listen = desktop.Listen
		cfg.Server.ExternalURL = desktop.URL
		cfg.Storage.Database = filepath.Join(filepath.Dir(*configPath), "seme.db")
	}

	if *healthcheck {
		return probeHealth(cfg.Server.Listen)
	}
	listener, err := net.Listen("tcp", cfg.Server.Listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.Server.Listen, err)
	}
	defer listener.Close()

	logger := newLogger(cfg.Log.Level)
	slog.SetDefault(logger)

	// Generate api token / admin password on first run and persist them.
	changed, err := config.EnsureSecrets(&cfg)
	if err != nil {
		return err
	}
	if changed {
		if err := config.Save(cfg, *configPath); err != nil {
			logger.Warn("could not persist generated secrets; they will change on restart",
				"error", err, "config", *configPath)
		}
		if !*desktopMode {
			logger.Info("generated admin password (also saved to config)",
				"admin_password", cfg.Server.AdminPassword,
				"config", *configPath)
		}
	}

	db, err := store.Open(cfg.Storage.Database)
	if err != nil {
		return err
	}
	defer db.Close()

	db.SetDeletionRetention(cfg.Cleanup.HistoryRetention)

	cm := config.NewManager(cfg, *configPath)
	dc := downloader.NewSwappable(buildDownloadClient(cfg))

	torrentSvc := torrents.New(db, dc, func() torrents.Settings {
		c := cm.Get()
		return torrents.Settings{
			MetadataTimeout:     c.Meta.MetadataTimeout,
			DeleteFilesOnRemove: c.Storage.DeleteFilesOnRemove,
			SeedFull:            c.Seeding.Full,
		}
	}, logger)

	metaClient := meta.New(cfg.Meta.CinemetaURL, cfg.Meta.TMDbAPIKey)
	stremioHandler := stremio.New(torrentSvc, metaClient, func() stremio.Settings {
		c := cm.Get()
		return stremio.Settings{
			ExternalURL:  c.Server.ExternalURL,
			ManagedLabel: c.ClientLabel(),
			Torrentio: stremio.TorrentioSettings{
				Enabled: c.Torrentio.Enabled,
				URL:     c.Torrentio.URL,
				Timeout: c.Torrentio.Timeout,
			},
			Prowlarr: stremio.ProwlarrSettings{
				URL:             c.Prowlarr.URL,
				APIKey:          c.Prowlarr.APIKey,
				MovieCategories: c.Prowlarr.MovieCategories,
				TVCategories:    c.Prowlarr.TVCategories,
				AnimeCategories: c.Prowlarr.AnimeCategories,
				IndexerIDs:      c.Prowlarr.IndexerIDs,
				SearchTimeout:   c.Prowlarr.SearchTimeout,
				SearchCacheTTL:  c.Prowlarr.SearchCacheTTL,
			},
			Addon: stremio.AddonSettings{
				EnableMovies: c.Addon.EnableMovies,
				EnableSeries: c.Addon.EnableSeries,
				EnableAnime:  c.Addon.EnableAnime,
			},
			Filters: prowlarr.Filters{
				MinSeeders:   c.Filters.MinSeeders,
				MinSizeBytes: c.Filters.MinSizeMB << 20,
				MaxSizeBytes: c.Filters.MaxSizeMB << 20,
			},
			MaxResults: c.Filters.MaxResults,
			Disk: stremio.DiskSettings{
				MaxUsagePercent: c.Storage.MaxDiskUsagePercent,
				Path:            firstLocalMapping(c.Paths.Mappings),
			},
		}
	}, version, logger)

	resolver := stream.NewResolver(dc, func() []config.Mapping { return cm.Get().Paths.Mappings })
	avail := stream.NewAvailability(dc)
	sessions := playsession.New()
	streamHandler := stream.NewHandler(db, dc, torrentSvc, resolver, avail, sessions, func() stream.Settings {
		c := cm.Get()
		return stream.Settings{
			KeepForever:          c.Cleanup.KeepForever,
			WaitTimeout:          c.Stream.WaitTimeout,
			ReadChunk:            c.Stream.ReadChunk,
			MinProgressForCancel: c.Cleanup.MinProgressForCancel,
		}
	}, logger)

	adminHandler := admin.New(cm, db, dc, torrentSvc, buildDownloadClient, version, logger)

	syncCtx, stopSync := context.WithCancel(context.Background())
	defer stopSync()
	go syncer.New(db, dc, logger, 30*time.Second).Run(syncCtx)

	cleanCtx, stopClean := context.WithCancel(context.Background())
	defer stopClean()
	go cleanup.New(db, dc, torrentSvc, sessions, func() cleanup.Settings {
		c := cm.Get()
		return cleanup.Settings{
			KeepForever:      c.Cleanup.KeepForever,
			SeedTime:         c.Cleanup.SeedTime,
			TargetRatio:      c.Cleanup.TargetRatio,
			DeletePolicy:     c.Cleanup.DeletePolicy,
			IndexerSeedTimes: c.Cleanup.IndexerSeedTimes,
		}
	}, logger, 30*time.Minute).Run(cleanCtx)

	adoptCtx, stopAdopt := context.WithCancel(context.Background())
	defer stopAdopt()
	go adopt.New(db, dc, func() adopt.Settings {
		c := cm.Get()
		return adopt.Settings{
			Enabled: c.Downloader.AdoptLabelled,
			Label:   c.ClientLabel(),
		}
	}, logger, time.Minute).Run(adoptCtx)

	rssCtx, stopRSS := context.WithCancel(context.Background())
	defer stopRSS()
	go rss.New(db, dc, torrentSvc, func() rss.Settings {
		c := cm.Get()
		return rss.Settings{
			Enabled:        c.RSS.Enabled,
			ProwlarrURL:    c.Prowlarr.URL,
			ProwlarrAPIKey: c.Prowlarr.APIKey,
			Categories:     rssCategories(c),
			IndexerIDs:     c.Prowlarr.IndexerIDs,
			// RSS uses its own size bounds but inherits the global seeder
			// floor as a ratio-safety default.
			Filters:                 prowlarr.Filters{MinSeeders: c.Filters.MinSeeders, MinSizeBytes: c.RSS.Filters.MinSizeMB << 20, MaxSizeBytes: c.RSS.Filters.MaxSizeMB << 20},
			FreeleechOnly:           c.RSS.FreeleechOnly,
			IncludeKeywords:         c.RSS.Filters.IncludeKeywords,
			ExcludeKeywords:         c.RSS.Filters.ExcludeKeywords,
			MaxGrabsPerCycle:        c.RSS.MaxGrabsPerCycle,
			SearchTimeout:           c.Prowlarr.SearchTimeout,
			MaxConcurrentDownloads:  c.RSS.MaxConcurrentDownloads,
			MaxActiveTorrents:       c.RSS.MaxActiveTorrents,
			DiskPath:                firstLocalMapping(c.Paths.Mappings),
			MaxDiskUsagePercent:     c.Storage.MaxDiskUsagePercent,
			MaxDownloadStorageBytes: c.Storage.MaxDownloadStorageGB << 30,
		}
	}, logger, cfg.RSS.Interval).Run(rssCtx)

	handler := server.New(server.Options{
		Logger:  logger,
		Stremio: stremioHandler.Router(),
		Stream:  streamHandler.Router(),
		Admin:   adminHandler.Router(),
	})

	httpServer := &http.Server{
		Addr:              cfg.Server.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("Sème listening", "addr", cfg.Server.Listen, "version", version)
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	if *desktopMode && *desktopReady != "" {
		if err := desktop.WriteReady(*desktopReady, cfg); err != nil {
			_ = httpServer.Close()
			return fmt.Errorf("publish desktop readiness: %w", err)
		}
		defer os.Remove(*desktopReady)
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(quit)
	parentCtx, stopParentWatch := context.WithCancel(context.Background())
	defer stopParentWatch()
	var parentGone <-chan struct{}
	if *desktopMode {
		parentGone = watchParent(parentCtx, parentPID)
	}

	select {
	case err := <-errCh:
		return err
	case sig := <-quit:
		logger.Info("shutting down", "signal", sig.String())
	case <-parentGone:
		logger.Info("desktop application exited; shutting down companion service")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return httpServer.Shutdown(ctx)
}

// A force-quit or crash of the native app must not leave its helper behind.
// Normal app termination sends SIGTERM; reparenting covers abrupt termination.
func watchParent(ctx context.Context, parentPID int) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if os.Getppid() != parentPID {
					close(done)
					return
				}
			}
		}
	}()
	return done
}

// buildDownloadClient constructs the download client selected by
// downloader.type. An empty legacy value continues to mean qBittorrent.
func buildDownloadClient(cfg config.Config) downloader.Client {
	if cfg.Downloader.Type == config.DownloaderTransmission {
		return transmission.New(cfg.Transmission.URL, cfg.Transmission.Username, cfg.Transmission.Password, cfg.Transmission.Label, cfg.Transmission.DownloadDir)
	}
	if cfg.Downloader.Type == config.DownloaderDeluge {
		return deluge.New(cfg.Deluge.Host, cfg.Deluge.Port, cfg.Deluge.Username, cfg.Deluge.Password, cfg.Deluge.Label)
	}
	return qbit.New(cfg.QBittorrent.URL, cfg.QBittorrent.Username, cfg.QBittorrent.Password, cfg.QBittorrent.Category)
}

// rssCategories combines the newznab category ids to poll for recent
// releases, restricted to the content types the addon currently serves so
// the grabber never fetches categories the addon can't stream.
func rssCategories(c config.Config) []int {
	// An explicit RSS category list overrides the addon-derived default,
	// letting the grabber poll a narrower (or different) set than what the
	// addon serves.
	if len(c.RSS.Filters.Categories) > 0 {
		return c.RSS.Filters.Categories
	}
	var cats []int
	if c.Addon.EnableMovies {
		cats = append(cats, c.Prowlarr.MovieCategories...)
	}
	if c.Addon.EnableSeries {
		cats = append(cats, c.Prowlarr.TVCategories...)
	}
	if c.Addon.EnableAnime {
		cats = append(cats, c.Prowlarr.AnimeCategories...)
	}
	return cats
}

// firstLocalMapping returns the first configured local download root, used
// as the path whose disk usage gates new streams. Empty when no mapping is
// configured, which disables the gate.
func firstLocalMapping(mappings []config.Mapping) string {
	return config.Paths{Mappings: mappings}.FirstLocal()
}

func defaultConfigPath() string {
	if _, err := os.Stat("/config"); err == nil {
		return "/config/config.yaml"
	}
	return "config.yaml"
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	if fi, err := os.Stdout.Stat(); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
		return slog.New(slog.NewTextHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, opts))
}

func probeHealth(listen string) error {
	addr := listen
	if addr == "" {
		addr = ":8080"
	}
	if addr[0] == ':' {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + addr + "/api/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health check returned %d", resp.StatusCode)
	}
	return nil
}

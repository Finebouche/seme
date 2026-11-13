package admin

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
)

const directoryEntryLimit = 1000

type directoryItem struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type directoryListing struct {
	Path        string          `json:"path"`
	Parent      string          `json:"parent"`
	Directories []directoryItem `json:"directories"`
	Truncated   bool            `json:"truncated"`
}

// directories browses existing folders on the Sème host for authenticated admins.
// It neither creates directories nor returns file names or contents. Symlinks are
// omitted from children; explicitly requested symlink paths are canonicalized.
func (h *Handler) directories(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	var err error
	if path == "" {
		path, err = os.UserHomeDir()
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "home directory unavailable")
		return
	}
	if !filepath.IsAbs(path) {
		writeJSONError(w, http.StatusBadRequest, "path must be absolute")
		return
	}
	path, err = filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		directoryError(w, err)
		return
	}
	dir, err := os.Open(path)
	if err != nil {
		directoryError(w, err)
		return
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil {
		directoryError(w, err)
		return
	}
	if !info.IsDir() {
		writeJSONError(w, http.StatusBadRequest, "path must be a directory")
		return
	}
	entries, err := dir.ReadDir(directoryEntryLimit + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		directoryError(w, err)
		return
	}
	result := directoryListing{Path: path, Parent: filepath.Dir(path), Directories: []directoryItem{}, Truncated: len(entries) > directoryEntryLimit}
	if result.Parent == path {
		result.Parent = ""
	}
	if len(entries) > directoryEntryLimit {
		entries = entries[:directoryEntryLimit]
	}
	for _, entry := range entries {
		if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			result.Directories = append(result.Directories, directoryItem{Name: entry.Name(), Path: filepath.Join(path, entry.Name())})
		}
	}
	sort.Slice(result.Directories, func(i, j int) bool { return result.Directories[i].Name < result.Directories[j].Name })
	writeJSON(w, http.StatusOK, result)
}

func directoryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, os.ErrPermission):
		writeJSONError(w, http.StatusForbidden, "directory access denied")
	case errors.Is(err, os.ErrNotExist):
		writeJSONError(w, http.StatusNotFound, "directory not found")
	default:
		writeJSONError(w, http.StatusBadRequest, "directory cannot be opened")
	}
}

package admin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDirectoriesRequireAuthentication(t *testing.T) {
	e := newEnv(t)
	if result := e.do(t, http.MethodGet, "/directories", ""); result.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", result.Code)
	}
}

func TestDirectoriesListOnlyRealFolders(t *testing.T) {
	e := newEnv(t)
	e.login(t)
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "private-file"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "folder"), filepath.Join(root, "symlink")); err != nil {
		t.Fatal(err)
	}
	result := e.do(t, http.MethodGet, "/directories?path="+url.QueryEscape(root), "")
	if result.Code != http.StatusOK {
		t.Fatalf("status=%d %s", result.Code, result.Body.String())
	}
	var listing directoryListing
	if err := json.Unmarshal(result.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if listing.Path != canonical || listing.Parent != filepath.Dir(canonical) || len(listing.Directories) != 1 || listing.Directories[0].Name != "folder" || listing.Directories[0].Path != filepath.Join(canonical, "folder") {
		t.Fatalf("unexpected listing: %+v", listing)
	}
}

func TestDirectoriesDefaultAndRootParent(t *testing.T) {
	e := newEnv(t)
	e.login(t)
	root := t.TempDir()
	t.Setenv("HOME", root)
	response := e.do(t, http.MethodGet, "/directories", "")
	var listing directoryListing
	if err := json.Unmarshal(response.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	canonical, _ := filepath.EvalSymlinks(root)
	if listing.Path != canonical {
		t.Fatalf("default=%q", listing.Path)
	}
	response = e.do(t, http.MethodGet, "/directories?path=/", "")
	if err := json.Unmarshal(response.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || listing.Parent != "" {
		t.Fatalf("root parent=%q status=%d", listing.Parent, response.Code)
	}
}

func TestDirectoriesRejectInvalidPathsWithoutCreating(t *testing.T) {
	e := newEnv(t)
	e.login(t)
	root := t.TempDir()
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(root, "missing")
	for _, tc := range []struct {
		path   string
		status int
	}{{"relative", 400}, {missing, 404}, {file, 400}} {
		result := e.do(t, http.MethodGet, "/directories?path="+url.QueryEscape(tc.path), "")
		if result.Code != tc.status {
			t.Errorf("path=%q status=%d body=%s", tc.path, result.Code, result.Body.String())
		}
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("directory browsing created a path")
	}
}

func TestDirectoriesBoundEntries(t *testing.T) {
	e := newEnv(t)
	e.login(t)
	root := t.TempDir()
	for i := 0; i < directoryEntryLimit+1; i++ {
		if err := os.Mkdir(filepath.Join(root, fmt.Sprintf("folder-%04d", i)), 0700); err != nil {
			t.Fatal(err)
		}
	}
	result := e.do(t, http.MethodGet, "/directories?path="+url.QueryEscape(root), "")
	var listing directoryListing
	if err := json.Unmarshal(result.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if !listing.Truncated || len(listing.Directories) != directoryEntryLimit {
		t.Fatalf("unbounded listing: truncated=%v count=%d", listing.Truncated, len(listing.Directories))
	}
}

func TestDirectoryPermissionErrorIsForbidden(t *testing.T) {
	recorder := httptest.NewRecorder()
	directoryError(recorder, &os.PathError{Op: "open", Path: "/private", Err: os.ErrPermission})
	if recorder.Code != http.StatusForbidden || strings.Contains(recorder.Body.String(), "/private") {
		t.Fatalf("permission response: %d %s", recorder.Code, recorder.Body.String())
	}
}

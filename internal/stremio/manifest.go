package stremio

import (
	"regexp"
	"strings"
)

// Manifest is the Stremio addon manifest.
type Manifest struct {
	ID            string             `json:"id"`
	Version       string             `json:"version"`
	Name          string             `json:"name"`
	Description   string             `json:"description"`
	Resources     []ManifestResource `json:"resources"`
	Types         []string           `json:"types"`
	Catalogs      []ManifestCatalog  `json:"catalogs"`
	IDPrefixes    []string           `json:"idPrefixes"`
	BehaviorHints map[string]any     `json:"behaviorHints,omitempty"`
}

type ManifestResource struct {
	Name       string   `json:"name"`
	Types      []string `json:"types"`
	IDPrefixes []string `json:"idPrefixes,omitempty"`
}

type ManifestCatalog struct {
	Type  string         `json:"type"`
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Extra []CatalogExtra `json:"extra,omitempty"`
}

type CatalogExtra struct {
	Name       string `json:"name"`
	IsRequired bool   `json:"isRequired"`
}

const manifestID = "com.finebouche.seme"

// fallbackVersion is served when the build-injected version isn't a valid
// semantic version (e.g. "dev", "docker", a branch name, or a git sha).
// Stremio rejects a manifest whose "version" isn't semver.
const fallbackVersion = "0.2.0"

// semverRE matches a semantic version with an optional leading "v" and
// optional prerelease/build metadata. This mirrors what Stremio accepts.
var semverRE = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)

// manifestVersion coerces the build version into something Stremio can
// parse, falling back to fallbackVersion when it isn't semver.
func manifestVersion(version string) string {
	v := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if semverRE.MatchString(v) {
		return v
	}
	return fallbackVersion
}

// BuildManifest assembles the manifest given the enabled content types.
func BuildManifest(version string, addon AddonSettings) Manifest {
	types := make([]string, 0, 3)
	idPrefixes := []string{}
	if addon.EnableMovies {
		types = append(types, "movie")
	}
	if addon.EnableSeries {
		types = append(types, "series")
	}
	if addon.EnableMovies || addon.EnableSeries {
		idPrefixes = append(idPrefixes, "tt")
	}
	if addon.EnableAnime {
		types = append(types, "anime")
		idPrefixes = append(idPrefixes, "kitsu", "mal", "anilist", "anidb")
	}

	types = append(types, seedType)
	idPrefixes = append(idPrefixes, seedIDPrefix)
	return Manifest{
		ID:          manifestID,
		Version:     manifestVersion(version),
		Name:        "Sème",
		Description: "Stream with Transmission, keep sharing after watching. Based on Seedstrem; sources from Torrentio or Prowlarr.",
		Resources: []ManifestResource{
			{Name: "stream", Types: types, IDPrefixes: idPrefixes},
			{Name: "catalog", Types: []string{seedType}},
			{Name: "meta", Types: []string{seedType}, IDPrefixes: []string{seedIDPrefix}},
		},
		Types:      types,
		Catalogs:   []ManifestCatalog{{Type: seedType, ID: seedCatalogID, Name: "Sème — Currently seeding", Extra: []CatalogExtra{{Name: "skip"}}}},
		IDPrefixes: idPrefixes,
		BehaviorHints: map[string]any{
			"configurable": false,
		},
	}
}

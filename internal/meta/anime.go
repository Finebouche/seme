package meta

import (
	"context"
	"fmt"
	"net/url"
)

// kitsuExternalSite maps an anime id source to Kitsu's mapping site key.
var kitsuExternalSite = map[string]string{
	"mal":     "myanimelist/anime",
	"anilist": "anilist/anime",
	"anidb":   "anidb",
}

// AnimeTitle resolves a human title for an anime id. Kitsu ids are looked
// up directly; other sources (mal/anilist/anidb) go through Kitsu's
// mappings endpoint.
func (c *Client) AnimeTitle(ctx context.Context, source, id string) (string, error) {
	info, err := c.AnimeMeta(ctx, source, id)
	return info.Name, err
}

// AnimeMeta resolves anime title, year, and optional poster using Kitsu.
// It shares the cache used by AnimeTitle.
func (c *Client) AnimeMeta(ctx context.Context, source, id string) (Info, error) {
	key := "anime:" + source + ":" + id
	if info, ok := c.cacheGet(key); ok {
		return info, nil
	}
	var info Info
	var err error
	switch source {
	case "kitsu":
		info, err = c.kitsuInfoByID(ctx, id)
	case "mal", "anilist", "anidb":
		info, err = c.kitsuInfoByMapping(ctx, kitsuExternalSite[source], id)
	default:
		return Info{}, fmt.Errorf("meta: unsupported anime source %q", source)
	}
	if err != nil {
		return Info{}, err
	}
	if info.Name == "" {
		return Info{}, fmt.Errorf("meta: no title for %s:%s", source, id)
	}
	c.cachePut(key, info)
	return info, nil
}

type kitsuAttributes struct {
	CanonicalTitle string            `json:"canonicalTitle"`
	Titles         map[string]string `json:"titles"`
	StartDate      string            `json:"startDate"`
	PosterImage    struct {
		Original string `json:"original"`
		Large    string `json:"large"`
		Medium   string `json:"medium"`
	} `json:"posterImage"`
}

func (a kitsuAttributes) title() string {
	if a.CanonicalTitle != "" {
		return a.CanonicalTitle
	}
	for _, k := range []string{"en", "en_jp", "en_us"} {
		if v := a.Titles[k]; v != "" {
			return v
		}
	}
	for _, v := range a.Titles {
		if v != "" {
			return v
		}
	}
	return ""
}

func (c *Client) kitsuInfoByID(ctx context.Context, id string) (Info, error) {
	var body struct {
		Data struct {
			Attributes kitsuAttributes `json:"attributes"`
		} `json:"data"`
	}
	if err := c.getJSON(ctx, c.kitsuURL+"/anime/"+url.PathEscape(id), &body); err != nil {
		return Info{}, err
	}
	return body.Data.Attributes.info(), nil
}

func (c *Client) kitsuInfoByMapping(ctx context.Context, site, id string) (Info, error) {
	q := url.Values{}
	q.Set("filter[externalSite]", site)
	q.Set("filter[externalId]", id)
	q.Set("include", "item")
	u := c.kitsuURL + "/mappings?" + q.Encode()

	var body struct {
		Included []struct {
			Type       string          `json:"type"`
			Attributes kitsuAttributes `json:"attributes"`
		} `json:"included"`
	}
	if err := c.getJSON(ctx, u, &body); err != nil {
		return Info{}, err
	}
	for _, inc := range body.Included {
		if inc.Type == "anime" {
			if t := inc.Attributes.title(); t != "" {
				return inc.Attributes.info(), nil
			}
		}
	}
	return Info{}, fmt.Errorf("meta: no kitsu mapping for %s:%s", site, id)
}

func (a kitsuAttributes) info() Info {
	info := Info{Name: a.title(), Year: parseYear(a.StartDate)}
	for _, candidate := range []string{a.PosterImage.Original, a.PosterImage.Large, a.PosterImage.Medium} {
		if poster := posterURL(candidate); poster != "" {
			info.Poster = poster
			break
		}
	}
	return info
}

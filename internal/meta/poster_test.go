package meta

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMetaPoster(t *testing.T) {
	for _, tc := range []struct{ name, field, want string }{
		{"known", `,"poster":"https://images.example/matrix.jpg"`, "https://images.example/matrix.jpg"},
		{"missing", "", ""},
		{"malformed", `,"poster":"https://[broken"`, ""},
		{"unsafe", `,"poster":"javascript:alert(1)"`, ""},
		{"relative", `,"poster":"/matrix.jpg"`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hits := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				hits++
				fmt.Fprintf(w, `{"meta":{"name":"The Matrix","year":"1999"%s}}`, tc.field)
			}))
			defer srv.Close()
			c := New(srv.URL, "")
			for i := 0; i < 2; i++ {
				got, err := c.Meta(context.Background(), "movie", "tt0133093")
				if err != nil {
					t.Fatal(err)
				}
				if got.Name != "The Matrix" || got.Year != 1999 || got.Poster != tc.want {
					t.Fatalf("got %+v", got)
				}
			}
			if hits != 1 {
				t.Fatalf("HTTP hits = %d, want 1", hits)
			}
		})
	}
}

func TestAnimeMetaPoster(t *testing.T) {
	for _, tc := range []struct{ name, field, want string }{
		{"original", `,"posterImage":{"original":"https://images.example/original.jpg","large":"https://images.example/large.jpg"}`, "https://images.example/original.jpg"},
		{"large", `,"posterImage":{"large":"https://images.example/large.jpg"}`, "https://images.example/large.jpg"},
		{"medium", `,"posterImage":{"medium":"http://images.example/medium.jpg"}`, "http://images.example/medium.jpg"},
		{"missing", "", ""},
		{"null", `,"posterImage":null`, ""},
		{"malformed", `,"posterImage":{"original":"https://[broken"}`, ""},
		{"unsafe fallback", `,"posterImage":{"original":"data:image/png;base64,abc","large":"https://images.example/large.jpg"}`, "https://images.example/large.jpg"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, source := range []string{"kitsu", "mal"} {
				t.Run(source, func(t *testing.T) {
					hits := 0
					srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						hits++
						attrs := fmt.Sprintf(`{"canonicalTitle":"Naruto","startDate":"2002-10-03"%s}`, tc.field)
						if source == "kitsu" {
							fmt.Fprintf(w, `{"data":{"attributes":%s}}`, attrs)
						} else {
							if r.URL.Path != "/mappings" || r.URL.Query().Get("include") != "item" {
								t.Errorf("bad mapping request %s", r.URL)
							}
							fmt.Fprintf(w, `{"included":[{"type":"anime","attributes":%s}]}`, attrs)
						}
					}))
					defer srv.Close()
					c := New("", "")
					c.kitsuURL = srv.URL
					for i := 0; i < 2; i++ {
						got, err := c.AnimeMeta(context.Background(), source, "20")
						if err != nil {
							t.Fatal(err)
						}
						if got.Name != "Naruto" || got.Year != 2002 || got.Poster != tc.want {
							t.Fatalf("got %+v", got)
						}
					}
					title, err := c.AnimeTitle(context.Background(), source, "20")
					if err != nil || title != "Naruto" {
						t.Fatalf("title=%q, err=%v", title, err)
					}
					if hits != 1 {
						t.Fatalf("HTTP hits = %d, want 1", hits)
					}
				})
			}
		})
	}
}

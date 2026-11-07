package httpserver

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

type probe struct {
	healthy, ready bool
}

func (p *probe) Health() (bool, string) { return p.healthy, "h" }
func (p *probe) Ready() (bool, string)  { return p.ready, "r" }

func TestProbes(t *testing.T) {
	p := &probe{healthy: true, ready: false}
	h := Handler(p)
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/health", http.StatusOK},
		{"/ready", http.StatusServiceUnavailable},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != tc.want {
			t.Errorf("%s: %d, want %d", tc.path, rec.Code, tc.want)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["status"] == "" {
			t.Errorf("%s: body %q", tc.path, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/health", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /health: %d", rec.Code)
	}
}

func TestCheck(t *testing.T) {
	p := &probe{healthy: true}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: Handler(p)}
	go srv.Serve(ln)
	defer srv.Close()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	if err := Check(":" + port); err != nil {
		t.Fatalf("healthy: %v", err)
	}
	p.healthy = false
	if err := Check(":" + port); err == nil {
		t.Fatal("unhealthy check passed")
	}
}

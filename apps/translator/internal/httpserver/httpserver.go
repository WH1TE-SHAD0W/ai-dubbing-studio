// Package httpserver serves the worker's two probes. There is no other
// inbound API: work arrives through the Redis Stream.
//
//	GET /health  200 while the worker's connections work (idle or busy)
//	GET /ready   200 only while idle and waiting on the stream, able to take a job
package httpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"
)

// Probe answers the two checks with a short reason.
type Probe interface {
	Health() (ok bool, detail string)
	Ready() (ok bool, detail string)
}

// Handler returns the probe routes.
func Handler(p Probe) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { write(w, p.Health) })
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, _ *http.Request) { write(w, p.Ready) })
	return mux
}

func write(w http.ResponseWriter, check func() (bool, string)) {
	ok, detail := check()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if !ok {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"status": detail})
}

// New returns a server for the probes.
func New(addr string, p Probe) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           Handler(p),
		ReadHeaderTimeout: 2 * time.Second,
		WriteTimeout:      2 * time.Second,
	}
}

// Check calls /health on the local server: the runtime image has no curl,
// so Compose runs `translator -healthcheck`.
func Check(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, port)+"/health", nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("health: %s", res.Status)
	}
	return nil
}

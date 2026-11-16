// Package config reads the worker's settings from the environment.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the worker's configuration.
type Config struct {
	// WorkerID is unique per process: Compose restarts reuse the hostname,
	// so a random suffix is added. It is the consumer name and the owner id.
	WorkerID string

	RedisURL  string
	JobStream string
	JobGroup  string

	ControlURL       string
	InternalAPIToken string

	GeminiAPIKey     string
	GeminiModel      string
	GeminiAPIVersion string
	GeminiMaxRetries int

	MediaDir string

	InBuffer       time.Duration
	OutBufferMax   time.Duration
	SendChunk      time.Duration
	MaxJob         time.Duration
	UnhealthyExit  time.Duration
	HTTPAddr       string
	LogLevel       slog.Level
	LogTranscripts bool
}

// Load reads the environment. getenv is os.Getenv outside tests.
func Load(getenv func(string) string) (Config, error) {
	var errs []error
	str := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	required := func(key string) string {
		v := strings.TrimSpace(getenv(key))
		if v == "" {
			errs = append(errs, fmt.Errorf("%s is required", key))
		}
		return v
	}
	num := func(key string, def, lo, hi int) int {
		v := strings.TrimSpace(getenv(key))
		if v == "" {
			return def
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < lo || n > hi {
			errs = append(errs, fmt.Errorf("%s must be a whole number from %d to %d", key, lo, hi))
			return def
		}
		return n
	}
	ms := func(key string, def, lo, hi int) time.Duration {
		return time.Duration(num(key, def, lo, hi)) * time.Millisecond
	}

	c := Config{
		RedisURL:         required("REDIS_URL"),
		JobStream:        str("JOB_STREAM", "translate:jobs"),
		JobGroup:         str("JOB_GROUP", "translators"),
		ControlURL:       required("CONTROL_API_URL"),
		InternalAPIToken: required("INTERNAL_API_TOKEN"),
		GeminiAPIKey:     required("GEMINI_API_KEY"),
		GeminiModel:      str("GEMINI_MODEL", "gemini-3.5-live-translate-preview"),
		GeminiAPIVersion: str("GEMINI_API_VERSION", "v1beta"),
		GeminiMaxRetries: num("GEMINI_MAX_RETRIES", 3, 1, 10),
		MediaDir:         str("MEDIA_DIR", "/media"),
		InBuffer:         ms("IN_BUFFER_MS", 200, 40, 2000),
		OutBufferMax:     ms("OUT_BUFFER_MAX_MS", 30000, 1000, 120000),
		SendChunk:        ms("SEND_CHUNK_MS", 100, 20, 1000),
		MaxJob:           time.Duration(num("MAX_JOB_MINUTES", 240, 1, 24*60)) * time.Minute,
		UnhealthyExit:    time.Duration(num("UNHEALTHY_EXIT_SEC", 60, 5, 3600)) * time.Second,
		HTTPAddr:         str("HTTP_ADDR", ":8080"),
		LogTranscripts:   str("LOG_TRANSCRIPTS", "") == "1",
	}
	if c.SendChunk%(20*time.Millisecond) != 0 {
		errs = append(errs, errors.New("SEND_CHUNK_MS must be a multiple of 20"))
	}
	if c.RedisURL != "" {
		if u, err := url.Parse(c.RedisURL); err != nil || (u.Scheme != "redis" && u.Scheme != "rediss") {
			errs = append(errs, errors.New("REDIS_URL must be a redis:// or rediss:// URL"))
		}
	}
	if c.ControlURL != "" {
		if u, err := url.Parse(c.ControlURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, errors.New("CONTROL_API_URL must be an http(s) URL"))
		}
	}
	if err := c.LogLevel.UnmarshalText([]byte(str("LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, errors.New("LOG_LEVEL must be debug, info, warn or error"))
	}

	id, err := workerID(getenv)
	if err != nil {
		errs = append(errs, err)
	}
	c.WorkerID = id
	if len(errs) > 0 {
		lines := make([]string, len(errs))
		for i, e := range errs {
			lines[i] = "  " + e.Error()
		}
		return Config{}, fmt.Errorf("invalid configuration:\n%s", strings.Join(lines, "\n"))
	}
	return c, nil
}

// workerID is WORKER_ID if set (tests), else hostname plus 6 random hex digits.
func workerID(getenv func(string) string) (string, error) {
	if v := strings.TrimSpace(getenv("WORKER_ID")); v != "" {
		return v, nil
	}
	host := strings.TrimSpace(getenv("POD_NAME"))
	if host == "" {
		h, err := os.Hostname()
		if err != nil || h == "" {
			h = "translator"
		}
		host = h
	}
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("worker id: %w", err)
	}
	return host + "-" + hex.EncodeToString(b), nil
}

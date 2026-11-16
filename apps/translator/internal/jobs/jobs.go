// Package jobs reads translation jobs from the Redis Stream (ADR-0018).
//
// Redis only delivers: the consumer group makes sure one job reaches one
// worker. Ownership lives in Postgres through Hono, so a job is acknowledged
// right after the claim (200 or 409) and there is no pending-entry recovery.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control/api"
)

// Job is one stream message.
type Job struct {
	// ID is the stream entry id, used to acknowledge it.
	ID string
	api.TranslationJob
}

// ErrMalformed marks a message that can never be processed. It is acked and dropped.
var ErrMalformed = errors.New("jobs: malformed message")

// Queue is a consumer of the jobs stream.
type Queue struct {
	rdb      *redis.Client
	stream   string
	group    string
	consumer string
	block    time.Duration
}

// New connects to Redis. consumer is the worker id.
func New(redisURL, stream, group, consumer string) (*Queue, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("jobs: %w", err)
	}
	// go-redis does not abort a blocking XREADGROUP when its context is
	// cancelled, so the BLOCK is kept short (1 s): an idle worker then exits
	// within about a second of SIGTERM. The read timeout must outlive it.
	opts.ReadTimeout = 5 * time.Second
	return &Queue{rdb: redis.NewClient(opts), stream: stream, group: group, consumer: consumer, block: time.Second}, nil
}

// Close closes the Redis connection.
func (q *Queue) Close() error { return q.rdb.Close() }

// Ping checks the connection.
func (q *Queue) Ping(ctx context.Context) error { return q.rdb.Ping(ctx).Err() }

// EnsureGroup creates the stream and group if needed. Hono creates them too;
// whoever is first wins and the other gets BUSYGROUP, which is fine.
func (q *Queue) EnsureGroup(ctx context.Context) error {
	err := q.rdb.XGroupCreateMkStream(ctx, q.stream, q.group, "0").Err()
	if err != nil && !strings.HasPrefix(err.Error(), "BUSYGROUP") {
		return fmt.Errorf("jobs: create group: %w", err)
	}
	return nil
}

// Read blocks for up to 1 s for one new job. It returns (nil, nil) when
// nothing arrived, so the caller can check for shutdown and loop.
func (q *Queue) Read(ctx context.Context) (*Job, error) {
	res, err := q.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    q.group,
		Consumer: q.consumer,
		Streams:  []string{q.stream, ">"},
		Count:    1,
		Block:    q.block,
	}).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	for _, s := range res {
		for _, m := range s.Messages {
			job, perr := Parse(m)
			if perr != nil {
				return &Job{ID: m.ID}, perr
			}
			return job, nil
		}
	}
	return nil, nil
}

// Ack acknowledges a message so it leaves the pending list.
func (q *Queue) Ack(ctx context.Context, id string) error {
	return q.rdb.XAck(ctx, q.stream, q.group, id).Err()
}

// DeleteConsumer removes this worker from the group on exit, so single-use
// workers don't leave stale consumers behind.
func (q *Queue) DeleteConsumer(ctx context.Context) error {
	return q.rdb.XGroupDelConsumer(ctx, q.stream, q.group, q.consumer).Err()
}

var langPattern = regexp.MustCompile(`^[a-z]{2}$`)

// Parse validates a stream message against the TranslationJob schema.
func Parse(m redis.XMessage) (*Job, error) {
	get := func(k string) string {
		v, _ := m.Values[k].(string)
		return v
	}
	j := &Job{ID: m.ID, TranslationJob: api.TranslationJob{
		V:         api.TranslationJobV(get("v")),
		JobId:     get("jobId"),
		SessionId: get("sessionId"),
		TrackId:   get("trackId"),
		Language:  get("language"),
	}}
	switch {
	case !j.V.Valid():
		return nil, fmt.Errorf("%w: unsupported version %q", ErrMalformed, j.V)
	case j.JobId == "" || j.SessionId == "" || j.TrackId == "":
		return nil, fmt.Errorf("%w: missing ids", ErrMalformed)
	case !langPattern.MatchString(j.Language):
		return nil, fmt.Errorf("%w: bad language %q", ErrMalformed, j.Language)
	}
	return j, nil
}

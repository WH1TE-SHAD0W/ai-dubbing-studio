package jobs

import (
	"errors"
	"testing"

	"github.com/redis/go-redis/v9"
)

func TestParseValidJob(t *testing.T) {
	j, err := Parse(redis.XMessage{ID: "1-0", Values: map[string]any{
		"v": "1", "jobId": "j1", "sessionId": "s1", "trackId": "t1", "language": "sk",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if j.ID != "1-0" || j.JobId != "j1" || j.SessionId != "s1" || j.TrackId != "t1" || j.Language != "sk" {
		t.Fatalf("job %+v", j)
	}
}

func TestParseRejectsMalformed(t *testing.T) {
	for name, values := range map[string]map[string]any{
		"no version":   {"jobId": "j", "sessionId": "s", "trackId": "t", "language": "sk"},
		"new version":  {"v": "2", "jobId": "j", "sessionId": "s", "trackId": "t", "language": "sk"},
		"missing ids":  {"v": "1", "jobId": "j", "language": "sk"},
		"bad language": {"v": "1", "jobId": "j", "sessionId": "s", "trackId": "t", "language": "SK-sk"},
	} {
		if _, err := Parse(redis.XMessage{ID: "1-0", Values: values}); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: err = %v, want ErrMalformed", name, err)
		}
	}
}

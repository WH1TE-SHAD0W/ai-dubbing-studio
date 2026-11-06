// Package lifecycle ends the worker process. Workers are single-use: after
// one job the process exits and a fresh one takes its place. In Docker
// Compose the restart policy starts the new process; on Kubernetes a hook
// that deletes the pod first (ADR-0018) will plug in here.
package lifecycle

import "os"

// ExitHook ends the process with a code.
type ExitHook interface {
	Exit(code int)
}

// OSExit calls os.Exit.
type OSExit struct{}

// Exit implements ExitHook.
func (OSExit) Exit(code int) { os.Exit(code) }

// Package stub marks code paths that are wired up but not built yet.
//
// Every unfinished feature returns stub.NotImplemented("<package>.<Func>"),
// so `grep -rn 'stub.NotImplemented' go/` lists exactly what is left, and
// callers (the CLI, the RPC layer) can tell "not built yet" apart from a
// real failure with errors.Is(err, stub.ErrNotImplemented).
package stub

import "errors"

// ErrNotImplemented matches every NotImplementedError via errors.Is.
var ErrNotImplemented = errors.New("not implemented yet")

// NotImplementedError names the unfinished feature.
type NotImplementedError struct {
	// Feature is "<package>.<Func>", for example "localapi.Client.Status".
	Feature string
}

func (e *NotImplementedError) Error() string {
	return e.Feature + ": " + ErrNotImplemented.Error()
}

// Is makes errors.Is(err, ErrNotImplemented) true for every
// NotImplementedError.
func (e *NotImplementedError) Is(target error) bool {
	return target == ErrNotImplemented
}

// NotImplemented returns the error for an unfinished feature.
func NotImplemented(feature string) error {
	return &NotImplementedError{Feature: feature}
}

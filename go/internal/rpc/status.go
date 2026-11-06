package rpc

import (
	"context"
	"errors"
	"maps"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/stub"
)

// Error is an error with a wire status code. Handlers return it to choose
// the code; callers get it back from Peer.Call when the remote failed.
type Error struct {
	Code    agentv1.StatusCode
	Message string
	Details map[string]string
}

// NewError returns an Error with the given code and user-facing message.
// There is deliberately no Errorf variant: the message reaches users, so it
// should be written on purpose, not assembled from wrapped internals.
func NewError(code agentv1.StatusCode, message string) *Error {
	return &Error{Code: code, Message: message}
}

func (e *Error) Error() string {
	return e.Code.String() + ": " + e.Message
}

// StatusOf converts any error into the Status sent on the wire. Unknown
// errors become INTERNAL with a generic message, so internal details (paths,
// addresses) never leak to the panel by accident; handlers that want the
// user to see a message return an *Error.
func StatusOf(err error) *agentv1.Status {
	if err == nil {
		return &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_OK}
	}
	var rpcErr *Error
	switch {
	case errors.As(err, &rpcErr):
		return &agentv1.Status{Code: rpcErr.Code, Message: rpcErr.Message, Details: maps.Clone(rpcErr.Details)}
	case errors.Is(err, stub.ErrNotImplemented):
		// Safe to show: the message only names the unfinished feature.
		return &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, Message: err.Error()}
	case errors.Is(err, context.Canceled):
		return &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_CANCELLED, Message: "cancelled"}
	case errors.Is(err, context.DeadlineExceeded):
		return &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED, Message: "deadline exceeded"}
	default:
		return &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_INTERNAL, Message: "internal error"}
	}
}

// ErrorOf converts a received Status into an error, nil for OK.
func ErrorOf(s *agentv1.Status) error {
	if s.GetCode() == agentv1.StatusCode_STATUS_CODE_OK {
		return nil
	}
	code := s.GetCode()
	if code == agentv1.StatusCode_STATUS_CODE_UNSPECIFIED {
		// A missing status is a protocol bug on the peer, not success.
		code = agentv1.StatusCode_STATUS_CODE_UNKNOWN
	}
	return &Error{Code: code, Message: s.GetMessage(), Details: maps.Clone(s.GetDetails())}
}

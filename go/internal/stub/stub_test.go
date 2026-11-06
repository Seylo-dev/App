package stub

import (
	"errors"
	"fmt"
	"testing"
)

func TestNotImplementedMatchesSentinel(t *testing.T) {
	err := fmt.Errorf("run agent: %w", NotImplemented("agent.Run"))

	if !errors.Is(err, ErrNotImplemented) {
		t.Fatal("wrapped stub error must match ErrNotImplemented")
	}
	var nie *NotImplementedError
	if !errors.As(err, &nie) || nie.Feature != "agent.Run" {
		t.Fatalf("errors.As lost the feature name: %v", err)
	}
	if got, want := err.Error(), "run agent: agent.Run: not implemented yet"; got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
}

func TestOtherErrorsDoNotMatch(t *testing.T) {
	if errors.Is(errors.New("boom"), ErrNotImplemented) {
		t.Fatal("unrelated error matched ErrNotImplemented")
	}
}

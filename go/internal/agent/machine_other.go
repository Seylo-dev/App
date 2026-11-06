//go:build !linux && !darwin

package agent

import "google.golang.org/protobuf/types/known/timestamppb"

// The agent daemon runs on Linux; these keep the laptop CLI building on
// other systems.

func osName() string                   { return "" }
func kernelRelease() string            { return "" }
func memoryTotal() uint64              { return 0 }
func bootTime() *timestamppb.Timestamp { return nil }

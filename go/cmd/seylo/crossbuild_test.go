package main

import (
	"os"
	"os/exec"
	"testing"
)

// TestCrossBuild compiles the binary for every release target: the agent
// for Linux, the laptop CLI for macOS and Windows (agent packages are not
// built there). Skipped with -short.
func TestCrossBuild(t *testing.T) {
	if testing.Short() {
		t.Skip("cross-compiling takes a while")
	}
	gobin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go command on PATH")
	}
	targets := [][2]string{
		{"linux", "amd64"}, {"linux", "arm64"},
		{"darwin", "amd64"}, {"darwin", "arm64"},
		{"windows", "amd64"}, {"windows", "arm64"},
	}
	for _, tg := range targets {
		t.Run(tg[0]+"-"+tg[1], func(t *testing.T) {
			t.Parallel()
			cmd := exec.Command(gobin, "build", "-o", os.DevNull, ".")
			cmd.Env = append(os.Environ(), "GOOS="+tg[0], "GOARCH="+tg[1], "CGO_ENABLED=0")
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
		})
	}
}

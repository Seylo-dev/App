package build

import (
	"context"
	"fmt"
	"os"
	"testing"
)

// TestMain lets the test binary stand in for the agent binary as ssh's
// ProxyCommand (gitDialProgram is os.Executable): `<test binary> git-dial
// <proxy> <host:port>` runs GitDial instead of the tests.
func TestMain(m *testing.M) {
	if len(os.Args) == 4 && os.Args[1] == GitDialCommand {
		if err := GitDial(context.Background(), os.Args[2], os.Args[3], os.Stdin, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

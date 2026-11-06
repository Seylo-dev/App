//go:build integration

package update

import (
	"context"
	"os"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TestDockerDryRunOnVM reads the installed and available Docker versions
// from the real package manager (dry run: nothing is upgraded).
func TestDockerDryRunOnVM(t *testing.T) {
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	d := NewDockerUpdater(DockerOptions{}, &Lock{})
	res, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Docker %s, available %s", res.GetFromVersion(), res.GetToVersion())
	if !IsRelease(res.GetFromVersion()) || !IsRelease(res.GetToVersion()) || Compare(res.GetToVersion(), res.GetFromVersion()) < 0 {
		t.Fatalf("versions = %v", res)
	}
}

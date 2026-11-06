package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/build"
	"github.com/seylo-dev/app/go/internal/cleanup"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// Cleanup prunes the build cache through the Builder.
var _ cleanup.CachePruner = (*build.Service)(nil)

func wiredBuild(t *testing.T) (*Deps, *rpctest.Peer) {
	t.Helper()
	d, _ := newTestDeps(t)
	reg := rpc.NewAgentMux()
	if err := provideBuild(d); err != nil {
		t.Fatal(err)
	}
	if err := wireBuild(reg, d); err != nil {
		t.Fatal(err)
	}
	if err := reg.Err(); err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"build.run.v1", "tunnel.tcp.v1", "compose.parse.v1"} {
		if !slices.Contains(reg.Capabilities(), c) {
			t.Fatalf("capability %s not advertised: %v", c, reg.Capabilities())
		}
	}
	var names []string
	for _, c := range d.Components.List() {
		names = append(names, c.Name)
	}
	for _, n := range []string{"build-maintenance", "registry-relay", "registry-gc"} {
		if !slices.Contains(names, n) {
			t.Fatalf("component %s missing: %v", n, names)
		}
	}
	return d, rpctest.NewPeer(t, reg)
}

func TestWireBuildParseCompose(t *testing.T) {
	_, panel := wiredBuild(t)
	ctx := context.Background()
	var resp agentv1.ParseComposeResponse
	err := panel.Call(ctx, "ParseCompose", &agentv1.ParseComposeRequest{
		ComposeYaml: "services:\n  web:\n    image: nginx:${TAG}\n    ports: [\"8080:80\"]\n",
		Env:         map[string]string{"TAG": "1.27"},
	}, &resp)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(resp.GetProjectJson(), []byte(`nginx:1.27`)) || len(resp.GetWarnings()) != 1 {
		t.Fatalf("resp %s %v", resp.GetProjectJson(), resp.GetWarnings())
	}
	err = panel.Call(ctx, "ParseCompose", &agentv1.ParseComposeRequest{ComposeYaml: "services: ["}, &resp)
	if st := rpc.StatusOf(err); st.GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("bad yaml: %v", st)
	}
}

func TestWireBuildRejectsAndCancels(t *testing.T) {
	_, panel := wiredBuild(t)
	ctx := context.Background()
	s, err := panel.Open(ctx, "Build", &agentv1.BuildRequest{BuildId: "b1", ServiceId: "s1", ImageReference: "docker.io/x:1"})
	if err != nil {
		t.Fatal(err)
	}
	var msg agentv1.BuildResponse
	if err := s.Recv(&msg); rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("invalid build: %v", err)
	}
	err = panel.Call(ctx, "CancelBuild", &agentv1.CancelBuildRequest{BuildId: "nope"}, &agentv1.CancelBuildResponse{})
	if rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("cancel unknown: %v", err)
	}
}

func TestWireBuildUploadContext(t *testing.T) {
	d, panel := wiredBuild(t)
	ctx := context.Background()
	archive := []byte("not really a tarball, the upload only checks size and hash")
	sum := sha256.Sum256(archive)
	s, err := panel.Open(ctx, "UploadBuildContext", &agentv1.UploadBuildContextRequest{UploadId: "u1", SizeBytes: uint64(len(archive)), Sha256: hex.EncodeToString(sum[:])})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(archive); err != nil {
		t.Fatal(err)
	}
	_ = s.CloseSend()
	if err := s.Finish(&agentv1.UploadBuildContextResponse{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(d.Layout.BuildsDir(), "uploads", "u1.tar.gz")); err != nil {
		t.Fatalf("upload not stored: %v", err)
	}

	s, _ = panel.Open(ctx, "UploadBuildContext", &agentv1.UploadBuildContextRequest{UploadId: "u2", SizeBytes: 3, Sha256: hex.EncodeToString(sum[:])})
	_, _ = s.Write([]byte("abc"))
	_ = s.CloseSend()
	if err := s.Finish(&agentv1.UploadBuildContextResponse{}); rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("bad hash: %v", err)
	}
}

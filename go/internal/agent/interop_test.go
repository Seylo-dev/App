//go:build interop

package agent

// Interop test against the real TypeScript panel. It is driven by
// scripts that start a panel, create a join token and then exercise the
// agent from the panel side (see CONTRACTS.md "Agent wiring" for how it
// was run). Without SEYLO_INTEROP_PANEL_URL it skips.
//
//	SEYLO_INTEROP_PANEL_URL=http://127.0.0.1:3132 SEYLO_INTEROP_TOKEN=... \
//	SEYLO_INTEROP_DONE=/tmp/x/done go test -tags interop -run TestInteropRealPanel ./internal/agent/

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// interopPattern is the byte at offset i of every FsRead download.
func interopPattern(i int) byte { return byte(i*7 + i/1024) }

func TestInteropRealPanel(t *testing.T) {
	url, token, done := os.Getenv("SEYLO_INTEROP_PANEL_URL"), os.Getenv("SEYLO_INTEROP_TOKEN"), os.Getenv("SEYLO_INTEROP_DONE")
	if url == "" || token == "" || done == "" {
		t.Skip("set SEYLO_INTEROP_PANEL_URL, SEYLO_INTEROP_TOKEN and SEYLO_INTEROP_DONE")
	}
	isolate(t)
	sync := owners[0]
	owners = []owner{sync, {"interop-streams", func(*Deps) error { return nil }, func(reg *Registry, d *Deps) error {
		rpc.HandleStream(reg, "LogsFollow", func(ctx context.Context, first *agentv1.LogsFollowRequest, s *rpc.TypedStream[*agentv1.LogsFollowRequest, *agentv1.LogsFollowResponse]) error {
			for i := range first.GetTail() {
				line := bytes.Repeat([]byte{'a' + byte(i%26)}, 200)
				if err := s.Send(&agentv1.LogsFollowResponse{Entries: []*agentv1.LogEntry{{Generation: uint64(i), Line: string(line)}}}); err != nil {
					t.Logf("LogsFollow ended after %d messages: %v", i, err)
					return err
				}
			}
			if first.GetServiceId() == "follow-forever" {
				<-ctx.Done()
				t.Logf("LogsFollow follow-forever ended: %v", ctx.Err())
				return ctx.Err()
			}
			return nil
		})
		rpc.HandleStream(reg, "Shell", func(ctx context.Context, first *agentv1.ShellRequest, s *rpc.TypedStream[*agentv1.ShellRequest, *agentv1.ShellResponse]) error {
			for {
				req, err := s.Recv()
				if err == io.EOF {
					return s.Send(&agentv1.ShellResponse{Message: &agentv1.ShellResponse_ExitCode{ExitCode: 7}})
				}
				if err != nil {
					return err
				}
				out := append([]byte("echo:"), req.GetInput()...)
				if err := s.Send(&agentv1.ShellResponse{Message: &agentv1.ShellResponse_Output{Output: out}}); err != nil {
					return err
				}
			}
		})
		rpc.HandleRaw(reg, "FsRead", func(ctx context.Context, req *agentv1.FsReadRequest, s rpc.RawStream) (*agentv1.FsReadResponse, error) {
			n := int(req.GetLength())
			buf := make([]byte, 64<<10)
			for off := 0; off < n; {
				chunk := min(len(buf), n-off)
				for i := range chunk {
					buf[i] = interopPattern(off + i)
				}
				if _, err := s.Write(buf[:chunk]); err != nil {
					return nil, err
				}
				off += chunk
			}
			return &agentv1.FsReadResponse{Info: &agentv1.FileInfo{Name: req.GetPath(), Size: uint64(n)}}, nil
		})
		rpc.HandleRaw(reg, "FsWrite", func(ctx context.Context, req *agentv1.FsWriteRequest, s rpc.RawStream) (*agentv1.FsWriteResponse, error) {
			h := sha256.New()
			n, err := io.Copy(h, s)
			if err != nil {
				return nil, err
			}
			return &agentv1.FsWriteResponse{Info: &agentv1.FileInfo{Name: hex.EncodeToString(h.Sum(nil)), Size: uint64(n)}}, nil
		})
		notFound := rpc.NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "interop agent has no files")
		rpc.HandleUnary(reg, "FsList", func(context.Context, *agentv1.FsListRequest) (*agentv1.FsListResponse, error) { return nil, notFound })
		rpc.HandleUnary(reg, "FsStat", func(context.Context, *agentv1.FsStatRequest) (*agentv1.FsStatResponse, error) { return nil, notFound })
		rpc.HandleUnary(reg, "FsMkdir", func(context.Context, *agentv1.FsMkdirRequest) (*agentv1.FsMkdirResponse, error) { return nil, notFound })
		rpc.HandleUnary(reg, "FsRename", func(context.Context, *agentv1.FsRenameRequest) (*agentv1.FsRenameResponse, error) {
			return nil, notFound
		})
		rpc.HandleUnary(reg, "FsDelete", func(context.Context, *agentv1.FsDeleteRequest) (*agentv1.FsDeleteResponse, error) {
			return nil, notFound
		})
		rpc.HandleUnary(reg, "FsChmod", func(context.Context, *agentv1.FsChmodRequest) (*agentv1.FsChmodResponse, error) { return nil, notFound })
		return nil
	}}}

	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: url, Token: token, Name: "interop"}); err != nil {
		t.Fatal(err)
	}
	a := startDaemon(t, layout)
	ctx := context.Background()
	waitUntil(t, "the panel connection", func() bool {
		s, _ := a.d.backend.Status(ctx)
		return s.PanelConnected
	})
	cfg, _ := LoadConfig(layout.ConfigFile())
	t.Logf("INTEROP joined as node %s", cfg.NodeID)

	// The panel drops reports about services the node does not run, so the
	// driver places one here and names it.
	var serviceID string
	waitUntil(t, "the driver's service id", func() bool {
		b, err := os.ReadFile(done + ".service")
		serviceID = strings.TrimSpace(string(b))
		return err == nil && serviceID != ""
	})
	t.Logf("INTEROP the driver placed service %s here", serviceID)

	// Agent -> panel: durable reports through the outbox, acked by the panel.
	if err := a.d.deps.Reports.Event(ctx, &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: &agentv1.NodeAlert{
		Kind: agentv1.NodeAlertKind_NODE_ALERT_KIND_DISK_LOW, Severity: agentv1.AlertSeverity_ALERT_SEVERITY_WARNING, Message: "interop disk alert",
	}}}); err != nil {
		t.Fatal(err)
	}
	if err := a.d.deps.Reports.Crash(ctx, &agentv1.CrashReport{ServiceId: serviceID, ExitCode: 137, OomKilled: true, Streak: 1, LastLines: []string{"killed"}}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the panel to ack both reports", func() bool {
		s, _ := a.d.backend.Status(ctx)
		return s.Outbox.Pending == 0
	})
	t.Logf("INTEROP outbox drained: the panel acked ReportEvent and ReportCrash")
	a.d.deps.State.SetService(&agentv1.ServiceStatus{ServiceId: serviceID, Phase: agentv1.ServicePhase_SERVICE_PHASE_RUNNING})

	// Wait while the driver exercises the agent from the panel side.
	deadline := time.Now().Add(3 * time.Minute)
	for {
		if _, err := os.Stat(done); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the driver never signalled done")
		}
		time.Sleep(100 * time.Millisecond)
	}
	s, _ := a.d.backend.Status(ctx)
	t.Logf("INTEROP final status: state=%s session=%s desired=%d errors=%v", s.Connection.State, s.Connection.SessionID, s.DesiredRevision, s.RecentErrors)
}

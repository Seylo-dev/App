package compose

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

var update = flag.Bool("update", false, "rewrite the .warnings golden files")

func load(t *testing.T, name string, env map[string]string) (*agentv1.ParseComposeResponse, error) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	return Parse(context.Background(), &agentv1.ParseComposeRequest{ComposeYaml: string(b), Env: env, ProjectName: "My Stack"})
}

// TestWarningsGolden compares the warnings of each fixture with
// testdata/<name>.warnings (go test -run Golden -update rewrites them).
func TestWarningsGolden(t *testing.T) {
	for _, name := range []string{"basic", "unsupported", "extends_local"} {
		t.Run(name, func(t *testing.T) {
			resp, err := load(t, name, map[string]string{"DB_PASSWORD": "pw"})
			if err != nil {
				t.Fatal(err)
			}
			got := strings.Join(resp.GetWarnings(), "\n")
			if got != "" {
				got += "\n"
			}
			golden := filepath.Join("testdata", name+".warnings")
			if *update {
				if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatal(err)
			}
			if got != string(want) {
				t.Fatalf("warnings:\n%s\nwant:\n%s", got, want)
			}
		})
	}
}

func TestParseNormalizesAndInterpolates(t *testing.T) {
	resp, err := load(t, "basic", map[string]string{"DB_PASSWORD": "pw", "WEB_TAG": "2.0"})
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		Name     string `json:"name"`
		Services map[string]struct {
			Image       string            `json:"image"`
			Environment map[string]string `json:"environment"`
			Deploy      struct {
				Replicas int `json:"replicas"`
			} `json:"deploy"`
		} `json:"services"`
		Configs map[string]struct {
			Content string `json:"content"`
		} `json:"configs"`
	}
	if err := json.Unmarshal(resp.GetProjectJson(), &p); err != nil {
		t.Fatal(err)
	}
	web := p.Services["web"]
	if p.Name != "mystack" || web.Image != "ghcr.io/acme/web:2.0" || web.Deploy.Replicas != 2 {
		t.Fatalf("project %+v", p)
	}
	if web.Environment["DATABASE_URL"] != "postgres://app:pw@db:5432/app" {
		t.Fatalf("env %v", web.Environment)
	}
	if p.Configs["web_conf"].Content != "listen 3000\n" {
		t.Fatalf("config content %q", p.Configs["web_conf"].Content)
	}
}

func TestParseExtendsWithinTheFile(t *testing.T) {
	resp, err := load(t, "extends_local", nil)
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		Services map[string]struct {
			Environment map[string]string `json:"environment"`
		} `json:"services"`
	}
	if err := json.Unmarshal(resp.GetProjectJson(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Services["worker"].Environment["LOG_LEVEL"] != "info" {
		t.Fatalf("worker did not inherit base: %s", resp.GetProjectJson())
	}
}

func TestParseNeverReadsTheNode(t *testing.T) {
	for _, name := range []string{"include", "extends_file"} {
		_, err := load(t, name, nil)
		var inv *InvalidError
		if !errors.As(err, &inv) || !strings.Contains(inv.Msg, "not supported") {
			t.Errorf("%s: got %v", name, err)
		}
		if err != nil && strings.Contains(err.Error(), "root:") {
			t.Errorf("%s: a node file leaked into the error: %v", name, err)
		}
	}
}

func TestParseRejectsBadInput(t *testing.T) {
	if _, err := load(t, "invalid", nil); err == nil {
		t.Fatal("invalid compose file accepted")
	} else if inv := (*InvalidError)(nil); !errors.As(err, &inv) {
		t.Fatalf("got %T %v", err, err)
	}
	for name, yaml := range map[string]string{
		"empty":    "  \n",
		"too big":  strings.Repeat("#", MaxYAMLBytes+1),
		"not yaml": "services: [",
	} {
		_, err := Parse(context.Background(), &agentv1.ParseComposeRequest{ComposeYaml: yaml})
		var inv *InvalidError
		if !errors.As(err, &inv) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

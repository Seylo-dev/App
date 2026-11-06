package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/compose-spec/compose-go/v2/loader"
	"github.com/compose-spec/compose-go/v2/template"
	"github.com/compose-spec/compose-go/v2/types"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// MaxYAMLBytes bounds a compose file.
const MaxYAMLBytes = 512 << 10

// DefaultProjectName is used when the request names none.
const DefaultProjectName = "stack"

// fileName is the name compose-go reports in errors.
const fileName = "compose.yaml"

// InvalidError is a compose file that cannot be loaded. Msg is meant for
// the person who wrote it.
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

// errNoFiles is what the deny loader returns for any file access.
var errNoFiles = errors.New("compose files can not read other files on the node")

// denyLoader refuses every resource compose-go would load from disk or
// the network (include, extends with file:).
type denyLoader struct{}

func (denyLoader) Accept(string) bool { return true }
func (denyLoader) Load(context.Context, string) (string, error) {
	return "", errNoFiles
}
func (denyLoader) Dir(string) string { return "." }

// Parse loads req.compose_yaml and returns the normalized project.
func Parse(ctx context.Context, req *agentv1.ParseComposeRequest) (*agentv1.ParseComposeResponse, error) {
	src := req.GetComposeYaml()
	if strings.TrimSpace(src) == "" {
		return nil, &InvalidError{Msg: "the compose file is empty"}
	}
	if len(src) > MaxYAMLBytes {
		return nil, &InvalidError{Msg: fmt.Sprintf("the compose file is larger than %d KiB", MaxYAMLBytes>>10)}
	}
	name := loader.NormalizeProjectName(req.GetProjectName())
	if name == "" {
		name = DefaultProjectName
	}

	env := map[string]string{}
	for k, v := range req.GetEnv() {
		env[k] = v
	}
	var mu sync.Mutex
	unset := map[string]bool{}
	details := types.ConfigDetails{
		// A folder that does not exist on purpose: nothing is read from it.
		WorkingDir:  "/nonexistent-compose-stack",
		ConfigFiles: []types.ConfigFile{{Filename: fileName, Content: []byte(src)}},
		Environment: env,
	}
	project, err := loader.LoadWithContext(ctx, details, func(o *loader.Options) {
		o.SetProjectName(name, true)
		o.ResolvePaths = false
		o.SkipResolveEnvironment = true
		o.SkipResolveLabels = true
		o.ResourceLoaders = []loader.ResourceLoader{denyLoader{}}
		o.Interpolate.LookupValue = func(key string) (string, bool) {
			v, ok := env[key]
			if !ok {
				mu.Lock()
				unset[key] = true
				mu.Unlock()
			}
			return v, ok
		}
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		msg := err.Error()
		if errors.Is(err, errNoFiles) {
			msg = "include and extends from other files are not supported: put everything in one compose file"
		}
		return nil, &InvalidError{Msg: msg}
	}

	out, err := projectJSON(project)
	if err != nil {
		return nil, fmt.Errorf("encoding the compose project: %w", err)
	}
	return &agentv1.ParseComposeResponse{ProjectJson: out, Warnings: Warnings(project, unsetWithoutDefault(src, unset))}, nil
}

// unsetWithoutDefault keeps the unset variables that the file uses
// without a default (${A:-x} falls back on purpose, ${A} does not).
func unsetWithoutDefault(src string, unset map[string]bool) []string {
	vars := template.ExtractVariables(map[string]any{"file": src}, nil)
	out := make([]string, 0, len(unset))
	for name := range unset {
		v, ok := vars[name]
		if ok && (v.DefaultValue != "" || v.PresenceValue != "") {
			continue
		}
		out = append(out, name)
	}
	return out
}

// projectJSON is compose-go's JSON, plus the inline content of configs
// and secrets, which it leaves out by default.
func projectJSON(p *types.Project) ([]byte, error) {
	raw, err := p.MarshalJSON(types.WithSecretContent)
	if err != nil {
		return nil, err
	}
	var withConfigs bool
	for _, c := range p.Configs {
		if c.Content != "" {
			withConfigs = true
		}
	}
	if !withConfigs {
		return raw, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	configs, _ := m["configs"].(map[string]any)
	for name, c := range p.Configs {
		if obj, ok := configs[name].(map[string]any); ok && c.Content != "" {
			obj["content"] = c.Content
		}
	}
	return json.Marshal(m)
}

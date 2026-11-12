package build

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestDockerfileArgs(t *testing.T) {
	for name, tc := range map[string]struct {
		text string
		want []string
	}{
		"stages, defaults, several per line": {
			text: "ARG NODE_VERSION=22\nFROM node:${NODE_VERSION} AS deps\nARG NPM_TOKEN\nRUN npm ci\n\n" +
				"FROM deps AS build\narg NEXT_PUBLIC_API_URL NEXT_PUBLIC_SITE_KEY=\"a b\" EMPTY=\n" +
				"ARG NPM_TOKEN\nRUN : \"${NEXT_PUBLIC_SITE_KEY:?is a required build arg}\"\n",
			want: []string{"NODE_VERSION", "NPM_TOKEN", "NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SITE_KEY", "EMPTY"},
		},
		"continuations and comments": {
			text: "FROM alpine\nARG A \\\n  # a comment between continued lines\n  B=1 \\\n\n  C\n# ARG NOT_AN_ARG\n  # ARG INDENTED_COMMENT\n",
			want: []string{"A", "B", "C"},
		},
		"heredocs are not instructions": {
			text: "FROM alpine\nRUN <<EOF\nARG IN_HEREDOC\nEOF\nRUN cat <<-'END' > /x && cat <<<\"ARG HERE_STRING\"\n\tARG IN_TABBED\n\tEND\nARG AFTER\n" +
				"COPY <<A <<B /dst/\nARG IN_A\nA\nARG IN_B\nB\nARG LAST\n",
			want: []string{"AFTER", "LAST"},
		},
		// BuildKit takes "<<" only at the start of a shell word: a shift, a word with "<<" inside,
		// a quoted one or "<< EOF" with a space starts no heredoc, so the ARGs after it count.
		"<< inside a word or in quotes": {
			text: "FROM a\nRUN x=$((1<<N)) && echo $x\nARG S1\nRUN echo \"<<EOF\" a<<b '<<Q' \\\n  && cat << EOF\nARG S2\nENV A=<<EOF\nARG S3\n",
			want: []string{"S1", "S2", "S3"},
		},
		// The delimiter is the rest of the word, quotes removed, not only letters and digits.
		"delimiter to the end of the word": {
			text: "FROM a\nRUN cat <<END-X\nARG S1\nEND-X\nARG S2\nRUN 3<<\"a.b\" cat /dev/fd/3\nARG IN\na.b\nARG S3\n",
			want: []string{"S2", "S3"},
		},
		"JSON form and ONBUILD": {
			text: "FROM a\nRUN [\"sh\", \"-c\", \"cat <<EOF\"]\nARG J\nONBUILD RUN <<EOF\nARG IN_ONBUILD\nEOF\nARG AFTER\n",
			want: []string{"J", "AFTER"},
		},
		"escape directive": {
			text: "# escape=`\nFROM mcr.microsoft.com/windows/servercore\nARG WIN_A `\n  WIN_B\nRUN dir c:\\\nARG WIN_C\n",
			want: []string{"WIN_A", "WIN_B", "WIN_C"},
		},
		"crlf and junk": {
			text: "FROM alpine\r\nARG CRLF\r\nARG\r\nARG 1BAD -x =y\r\nENV ARG=1\r\n",
			want: []string{"CRLF"},
		},
	} {
		if got := dockerfileArgs(tc.text); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %q, want %q", name, got, tc.want)
		}
	}
}

func TestMentionedSecretArgs(t *testing.T) {
	out := "--> " + secretArgNote("NPM_TOKEN") + "\n#9 0.2 /bin/sh: 1: SITE_KEY: is a required build arg\n#10 SITE_KEY_OTHER\n"
	if got := mentionedSecretArgs(out, []string{"NPM_TOKEN", "SITE_KEY", "KEY"}); !reflect.DeepEqual(got, []string{"SITE_KEY"}) {
		t.Fatalf("got %q", got)
	}
}

// buildLog runs one build and returns its final progress and whole log.
func buildLog(t *testing.T, svc *Service, rep *reports, req *agentv1.BuildRequest) (*agentv1.BuildProgress, string) {
	t.Helper()
	job, err := svc.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	p := finalOf(t, rep)
	var log strings.Builder
	_ = job.Watch(context.Background(), func(r *agentv1.BuildResponse) error { log.Write(r.GetLog()); return nil })
	return p, log.String()
}

// A Dockerfile build gets secret variables only as BuildKit secrets, so an
// ARG with a secret variable's name stays empty: the log says so before the
// build, and again last when the failed build's output names it. Values
// never show.
func TestBuildLogNamesSecretArgs(t *testing.T) {
	const secretValue = "Zx81kLq0Pw2mNv7Bc4Rt9Ys6"
	fail := false
	fr := &fakeRunner{}
	fr.build = func(_ context.Context, c Cmd) error {
		if !fail {
			fmt.Fprint(c.Stdout, "#5 DONE 0.1s\n")
			return nil
		}
		fmt.Fprint(c.Stdout, "#7 [build 3/4] RUN : \"${SITE_KEY:?is a required build arg}\"\n#7 0.105 /bin/sh: 1: SITE_KEY: is a required build arg\n#7 ERROR: process did not complete successfully: exit code: 2\n")
		return &ExitError{Cmd: "docker", Code: 1}
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	env := []*agentv1.EnvVar{
		{Name: "PUBLIC_URL", Value: "https://example.com"},
		{Name: "SITE_KEY", Value: secretValue, Secret: true},
		{Name: "NPM_TOKEN", Value: secretValue, Secret: true},
		{Name: "UNUSED_TOKEN", Value: secretValue, Secret: true},
	}
	// A shift is no heredoc: the ARGs after it still get their notes.
	dockerfile := "FROM node:22 AS deps\nARG NPM_TOKEN\nRUN echo $((1<<N))\nFROM deps AS build\nARG PUBLIC_URL\nARG SITE_KEY=placeholder\nRUN : \"${SITE_KEY:?is a required build arg}\"\n"
	inline := func(id string) *agentv1.BuildRequest {
		return &agentv1.BuildRequest{
			BuildId: id, ServiceId: "svc1", ImageReference: DefaultRegistry + "/svc1:" + id,
			Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_InlineDockerfile{InlineDockerfile: dockerfile}},
			Env:    env,
		}
	}
	notes := "--> " + secretArgNote("NPM_TOKEN") + "\n--> " + secretArgNote("SITE_KEY") + "\n"

	p, log := buildLog(t, svc, rep, inline("b1"))
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("final %v %q", p.GetStage(), p.GetMessage())
	}
	before, _, ok := strings.Cut(log, "--> Building "+DefaultRegistry)
	if !ok || !strings.HasSuffix(before, notes) {
		t.Fatalf("the notes are not right before the build:\n%s", log)
	}
	if strings.Contains(log, "PUBLIC_URL is a secret") || strings.Contains(log, "UNUSED_TOKEN") || strings.Contains(log, secretValue) {
		t.Fatalf("a note for a public or unused variable, or a value:\n%s", log)
	}
	if strings.Count(log, secretArgNote("SITE_KEY")) != 1 {
		t.Fatalf("a successful build repeats a note:\n%s", log)
	}

	fail = true
	p, log = buildLog(t, svc, rep, inline("b2"))
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_FAILED {
		t.Fatalf("final %v %q", p.GetStage(), p.GetMessage())
	}
	if want := "\n--> The build failed - the lines above say why\n--> " + secretArgNote("SITE_KEY") + "\n"; !strings.HasSuffix(log, want) {
		t.Fatalf("log does not end with %q:\n%s", want, log)
	}
	if strings.Contains(log, secretValue) {
		t.Fatalf("a value in the log:\n%s", log)
	}

	// The Dockerfile at the build's dockerfilePath in an uploaded context, and one typed in the
	// panel for that context (the repository's own Dockerfile has no ARG).
	fail = false
	archive := tarGz(t, entry{name: "docker/web.Dockerfile", body: dockerfile}, entry{name: "Dockerfile", body: "FROM scratch\n"})
	sum := sha256.Sum256(archive)
	for _, tc := range []struct{ id, path, content string }{
		{id: "b3", path: "docker/web.Dockerfile"},
		{id: "b5", path: "Dockerfile", content: dockerfile},
	} {
		up := &agentv1.UploadBuildContextRequest{UploadId: "ctx-" + tc.id, SizeBytes: uint64(len(archive)), Sha256: hex.EncodeToString(sum[:])}
		if err := svc.StoreContext(context.Background(), up, bytes.NewReader(archive)); err != nil {
			t.Fatal(err)
		}
		_, log = buildLog(t, svc, rep, &agentv1.BuildRequest{
			BuildId: tc.id, ServiceId: "svc1", ImageReference: DefaultRegistry + "/svc1:" + tc.id,
			Builder: agentv1.Builder_BUILDER_DOCKERFILE, DockerfilePath: tc.path, DockerfileContent: tc.content,
			Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_UploadId{UploadId: "ctx-" + tc.id}},
			Env:    env,
		})
		if before, _, _ := strings.Cut(log, "--> Building "+DefaultRegistry); !strings.HasSuffix(before, notes) {
			t.Fatalf("%s: no notes for the Dockerfile:\n%s", tc.id, log)
		}
	}

	// No secret ARG, no note.
	_, log = buildLog(t, svc, rep, inlineRequest("b4"))
	if strings.Contains(log, "is a secret, so the build gets it") {
		t.Fatalf("a note without a secret ARG:\n%s", log)
	}
}

func TestSecretArgsUnreadableDockerfile(t *testing.T) {
	env := []*agentv1.EnvVar{{Name: "A", Value: "x", Secret: true}}
	if got := secretArgs(filepath.Join(t.TempDir(), "missing"), env); got != nil {
		t.Fatalf("got %q", got)
	}
	f := filepath.Join(t.TempDir(), "Dockerfile")
	if err := os.WriteFile(f, []byte("FROM alpine\nARG A\nARG B\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := secretArgs(f, append(env, &agentv1.EnvVar{Name: "B", Value: "y"})); !reflect.DeepEqual(got, []string{"A"}) {
		t.Fatalf("got %q", got)
	}
}

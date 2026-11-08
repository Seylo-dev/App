package build

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestSizeFor(t *testing.T) {
	cases := []struct {
		cpus    int
		memGB   uint64
		want    Sizing
		comment string
	}{
		{2, 2, Sizing{2, 1}, "tiny node: never more memory than 3/4 of it"},
		{4, 8, Sizing{2, 4}, "minimums"},
		{16, 64, Sizing{4, 16}, "a quarter"},
		{64, 512, Sizing{8, 16}, "maximums"},
		{1, 16, Sizing{1, 4}, "never more cores than the machine"},
	}
	for _, c := range cases {
		if got := SizeFor(c.cpus, c.memGB<<30); got != c.want {
			t.Errorf("%s: SizeFor(%d, %dG) = %+v, want %+v", c.comment, c.cpus, c.memGB, got, c.want)
		}
	}
	if n := (Sizing{4, 16}).Name(); !strings.HasPrefix(n, BuilderPrefix+"-") || !strings.HasSuffix(n, "-4c-16g") {
		t.Errorf("name %q", n)
	}
}

func TestImagesToRemoveKeepsNewest(t *testing.T) {
	out := "3\t2026-11-03 10:00:00 +0000 UTC\n" +
		"5\t2026-11-05 10:00:00 +0000 UTC\n" +
		"<none>\t2026-11-05 11:00:00 +0000 UTC\n" +
		"4\t2026-11-04 10:00:00 +0000 UTC\n" +
		"1\t2026-11-01 10:00:00 +0000 UTC\n"
	imgs := parseImageList(out)
	if len(imgs) != 4 {
		t.Fatalf("parsed %d images: %+v", len(imgs), imgs)
	}
	var tags []string
	for _, img := range imagesToRemove(imgs, 2) {
		tags = append(tags, img.Tag)
	}
	if !slices.Equal(tags, []string{"3", "1"}) {
		t.Fatalf("removes %v, want [3 1]", tags)
	}
	if got := imagesToRemove(imgs, 10); got != nil {
		t.Fatalf("removes %v with room to keep all", got)
	}
}

func TestRepository(t *testing.T) {
	for in, want := range map[string]string{
		"127.0.0.1:5755/svc:12":                 "127.0.0.1:5755/svc",
		"127.0.0.1:5755/svc":                    "127.0.0.1:5755/svc",
		"nginx:1.27@sha256:" + hex64("a"):       "nginx",
		"ghcr.io/acme/api@sha256:" + hex64("b"): "ghcr.io/acme/api",
	} {
		if got := repository(in); got != want {
			t.Errorf("repository(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"nginx": "docker.io", "acme/api:1": "docker.io", "ghcr.io/a/b": "ghcr.io", "localhost/x": "localhost", "reg:5000/x": "reg:5000"} {
		if got := registryOf(in); got != want {
			t.Errorf("registryOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func hex64(c string) string { return strings.Repeat(c, 64) }

func TestBuildSpecArgsKeepValuesOutOfArgs(t *testing.T) {
	spec := buildSpec{
		Builder: "b", ContextDir: "/ctx", Dockerfile: "/ctx/Dockerfile", Target: "prod", Tag: "127.0.0.1:5755/s:1",
		BuildArgs: []KV{{"NODE_ENV", "production"}, {"PATH", "/x"}},
		Secrets:   []Secret{{"TOKEN", "/w/secrets/TOKEN"}},
	}
	args, env := spec.args()
	joined := strings.Join(args, " ")
	for _, want := range []string{"buildx build --builder b", "--load", "--provenance=false", "-t 127.0.0.1:5755/s:1", "--target prod", "--build-arg NODE_ENV ", "--build-arg PATH=/x", "--secret id=TOKEN,src=/w/secrets/TOKEN"} {
		if !strings.Contains(joined+" ", want) {
			t.Errorf("args %q lack %q", joined, want)
		}
	}
	if args[len(args)-1] != "/ctx" {
		t.Errorf("context is not last: %v", args)
	}
	if strings.Contains(joined, "production") {
		t.Errorf("a build arg value is in the process arguments: %q", joined)
	}
	if !slices.Equal(env, []string{"NODE_ENV=production"}) {
		t.Errorf("env %v", env)
	}
	// The legacy `docker build` has none of these flags: there is no
	// fallback to it.
	plain, _ := buildSpec{Tag: "x:1", Dockerfile: "D", ContextDir: "c"}.args()
	if !slices.Equal(plain[:2], []string{"buildx", "build"}) {
		t.Errorf("without a named builder: %v", plain)
	}
}

func TestImageLabels(t *testing.T) {
	spec := buildSpec{Tag: "127.0.0.1:5755/svc1:7", Dockerfile: "D", ContextDir: "c",
		Labels: imageLabels(&agentv1.BuildRequest{ServiceId: "svc1", ImageReference: "127.0.0.1:5755/svc1:7"})}
	args, _ := spec.args()
	joined := strings.Join(args, " ")
	for _, want := range []string{"--label seylo.managed=true", "--label seylo.service=svc1", "--label seylo.generation=7"} {
		if !strings.Contains(joined, want) {
			t.Errorf("args %q lack %q", joined, want)
		}
	}
	if got := imageLabels(&agentv1.BuildRequest{ServiceId: "s", ImageReference: "127.0.0.1:5755/s:latest"}); len(got) != 2 {
		t.Errorf("a non-numeric tag must not set a generation: %v", got)
	}
}

func TestValidateRequest(t *testing.T) {
	good := func() *agentv1.BuildRequest {
		return &agentv1.BuildRequest{
			BuildId: "b1", ServiceId: "svc1", ImageReference: "127.0.0.1:5755/svc1:3",
			Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_Git{Git: &agentv1.GitSource{Url: "https://github.com/acme/app.git", Ref: "main"}}},
		}
	}
	if err := validateRequest(good(), DefaultRegistry); err != nil {
		t.Fatalf("good request refused: %v", err)
	}
	bad := map[string]func(r *agentv1.BuildRequest){
		"id with slash":       func(r *agentv1.BuildRequest) { r.BuildId = "../x" },
		"push elsewhere":      func(r *agentv1.BuildRequest) { r.ImageReference = "docker.io/evil/x:1" },
		"untagged digest ref": func(r *agentv1.BuildRequest) { r.ImageReference = "127.0.0.1:5755/svc1@sha256:" + hex64("a") },
		"context escapes":     func(r *agentv1.BuildRequest) { r.ContextPath = "../../etc" },
		"absolute dockerfile": func(r *agentv1.BuildRequest) { r.DockerfilePath = "/etc/passwd" },
		"bad env name":        func(r *agentv1.BuildRequest) { r.Env = []*agentv1.EnvVar{{Name: "A B"}} },
		"duplicate env":       func(r *agentv1.BuildRequest) { r.Env = []*agentv1.EnvVar{{Name: "A"}, {Name: "A"}} },
		"file url":            func(r *agentv1.BuildRequest) { r.Source.GetGit().Url = "file:///etc" },
		"ext transport":       func(r *agentv1.BuildRequest) { r.Source.GetGit().Url = "ext::sh -c touch% /tmp/x" },
		"option as url":       func(r *agentv1.BuildRequest) { r.Source.GetGit().Url = "--upload-pack=touch /tmp/x" },
		"creds in url":        func(r *agentv1.BuildRequest) { r.Source.GetGit().Url = "https://u:p@github.com/a/b" },
		"option as ref":       func(r *agentv1.BuildRequest) { r.Source.GetGit().Ref = "--output=/tmp/x" },
		"bad commit":          func(r *agentv1.BuildRequest) { r.Source.GetGit().Commit = "HEAD~1" },
		"ssh url without key": func(r *agentv1.BuildRequest) { r.Source.GetGit().Url = "git@github.com:acme/app.git" },
		"no source":           func(r *agentv1.BuildRequest) { r.Source = nil },
		"stage":               func(r *agentv1.BuildRequest) { r.TargetStage = "a b" },
	}
	for name, mutate := range bad {
		r := good()
		mutate(r)
		err := validateRequest(r, DefaultRegistry)
		var inv *InvalidError
		if err == nil || !errors.As(err, &inv) {
			t.Errorf("%s: got %v, want an InvalidError", name, err)
		}
	}
	ssh := good()
	ssh.Source.GetGit().Url = "git@github.com:acme/app.git"
	ssh.Source.GetGit().SshPrivateKey = "key"
	if err := validateRequest(ssh, DefaultRegistry); err != nil {
		t.Errorf("scp-like address with a key: %v", err)
	}
}

func TestJobWatchReplaysAndFollows(t *testing.T) {
	j := newJob("b1", "s1", func() {})
	j.progress(&agentv1.BuildProgress{Stage: agentv1.BuildStage_BUILD_STAGE_QUEUED})
	_, _ = j.Write([]byte("line 1\n"))

	var got strings.Builder
	var stages []agentv1.BuildStage
	done := make(chan error, 1)
	go func() {
		done <- j.Watch(context.Background(), func(r *agentv1.BuildResponse) error {
			if p := r.GetProgress(); p != nil {
				stages = append(stages, p.GetStage())
			}
			got.Write(r.GetLog())
			return nil
		})
	}()
	time.Sleep(20 * time.Millisecond)
	_, _ = j.Write([]byte("line 2\n"))
	j.finish(&agentv1.BuildProgress{Stage: agentv1.BuildStage_BUILD_STAGE_SUCCEEDED})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got.String() != "line 1\nline 2\n" {
		t.Fatalf("log %q", got.String())
	}
	if !slices.Equal(stages, []agentv1.BuildStage{agentv1.BuildStage_BUILD_STAGE_QUEUED, agentv1.BuildStage_BUILD_STAGE_SUCCEEDED}) {
		t.Fatalf("stages %v", stages)
	}

	// A late watcher gets the whole thing and returns at once.
	var late strings.Builder
	if err := j.Watch(context.Background(), func(r *agentv1.BuildResponse) error { late.Write(r.GetLog()); return nil }); err != nil {
		t.Fatal(err)
	}
	if late.String() != got.String() {
		t.Fatalf("late watcher got %q", late.String())
	}
}

func TestJobDropsOldOutput(t *testing.T) {
	j := newJob("b1", "s1", func() {})
	chunk := strings.Repeat("x", 1<<20)
	for range 12 {
		_, _ = j.Write([]byte(chunk))
	}
	j.finish(&agentv1.BuildProgress{Stage: agentv1.BuildStage_BUILD_STAGE_FAILED})
	total := 0
	sawDrop := false
	_ = j.Watch(context.Background(), func(r *agentv1.BuildResponse) error {
		if strings.HasPrefix(string(r.GetLog()), "[earlier output dropped]") {
			sawDrop = true
		}
		total += len(r.GetLog())
		return nil
	})
	if !sawDrop || total > maxJobOutput+100 {
		t.Fatalf("dropped=%v total=%d", sawDrop, total)
	}
}

func TestCacheSizes(t *testing.T) {
	for in, want := range map[string]uint64{"0B": 0, "512B": 512, "12.5kB": 12500, "1.2GB": 1_200_000_000, "2MiB": 2 << 20, "junk": 0} {
		if got := parseSize(in); got != want {
			t.Errorf("parseSize(%q) = %d, want %d", in, got, want)
		}
	}
	out := "ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t1MB\nReclaimable:\t1.5GB\nTotal:\t\t2GB\n"
	if got := summaryBytes(out, "Reclaimable"); got != 1_500_000_000 {
		t.Errorf("reclaimable = %d", got)
	}
	if got := summaryBytes(out, "Total"); got != 2_000_000_000 {
		t.Errorf("total = %d", got)
	}
	if got := humanBytes(1_500_000_000); got != "1.5GB" {
		t.Errorf("humanBytes = %q", got)
	}
}

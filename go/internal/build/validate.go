package build

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

var (
	// Build, upload and service ids become file and image names.
	idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	// Branch or tag names: what git allows, minus anything an option
	// parser could mistake for a flag.
	refRe    = regexp.MustCompile(`^[A-Za-z0-9._/+@-]{1,255}$`)
	commitRe = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	// scp-like SSH address: git@github.com:org/repo.git
	scpRe = regexp.MustCompile(`^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/+-][A-Za-z0-9._~/+ -]*$`)
	// Variable names for build args and secrets.
	envNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	// Docker image references: [host[:port]/]path[:tag][@digest].
	imageRefRe = regexp.MustCompile(`^(?:[a-zA-Z0-9.-]+(?::[0-9]+)?/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$`)
	stageRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	sha256Re   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// InvalidError is a request the agent refuses before doing anything. Its
// message is meant for the person who started the build.
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

func invalid(format string, args ...any) error {
	return &InvalidError{Msg: fmt.Sprintf(format, args...)}
}

// validateRequest checks everything that becomes a path, an argument or
// an image name. pushPrefix is the registry the image must go to.
func validateRequest(req *agentv1.BuildRequest, pushPrefix string) error {
	if !idRe.MatchString(req.GetBuildId()) {
		return invalid("build id %q is not valid", req.GetBuildId())
	}
	if !idRe.MatchString(req.GetServiceId()) {
		return invalid("service id %q is not valid", req.GetServiceId())
	}
	ref := req.GetImageReference()
	if !imageRefRe.MatchString(ref) || strings.Contains(ref, "@") {
		return invalid("image reference %q is not a tagged image name", ref)
	}
	if !strings.HasPrefix(ref, pushPrefix+"/") {
		return invalid("images are pushed to the panel registry (%s), not %q", pushPrefix, ref)
	}
	if !safeRelPath(req.GetContextPath()) {
		return invalid("the build path %q must stay inside the source", req.GetContextPath())
	}
	if !safeRelPath(req.GetDockerfilePath()) {
		return invalid("the Dockerfile path %q must stay inside the source", req.GetDockerfilePath())
	}
	if s := req.GetTargetStage(); s != "" && !stageRe.MatchString(s) {
		return invalid("target stage %q is not valid", s)
	}
	seen := map[string]bool{}
	for _, e := range req.GetEnv() {
		if !envNameRe.MatchString(e.GetName()) {
			return invalid("%q is not a variable name", e.GetName())
		}
		if seen[e.GetName()] {
			return invalid("variable %s is set twice", e.GetName())
		}
		seen[e.GetName()] = true
	}
	switch b := req.GetBuilder(); b {
	case agentv1.Builder_BUILDER_UNSPECIFIED, agentv1.Builder_BUILDER_RAILPACK, agentv1.Builder_BUILDER_NIXPACKS, agentv1.Builder_BUILDER_DOCKERFILE:
	default:
		return invalid("unknown builder %v", b)
	}

	src := req.GetSource()
	switch s := src.GetSource().(type) {
	case *agentv1.BuildSource_Git:
		return validateGit(s.Git)
	case *agentv1.BuildSource_UploadId:
		if !idRe.MatchString(s.UploadId) {
			return invalid("upload id %q is not valid", s.UploadId)
		}
	case *agentv1.BuildSource_InlineDockerfile:
		if strings.TrimSpace(s.InlineDockerfile) == "" {
			return invalid("the Dockerfile is empty")
		}
	case *agentv1.BuildSource_Image:
		r := s.Image.GetReference()
		if !imageRefRe.MatchString(r) {
			return invalid("%q is not an image name", r)
		}
	default:
		return invalid("the build has no source")
	}
	return nil
}

func validateGit(g *agentv1.GitSource) error {
	if err := validateGitURL(g.GetUrl(), g.GetSshPrivateKey() != "", g.GetToken() != ""); err != nil {
		return err
	}
	if r := g.GetRef(); r != "" && (!refRe.MatchString(r) || strings.HasPrefix(r, "-") || strings.Contains(r, "..")) {
		return invalid("%q is not a branch or tag name", r)
	}
	if c := g.GetCommit(); c != "" && !commitRe.MatchString(c) {
		return invalid("%q is not a commit id", c)
	}
	if g.GetToken() != "" && g.GetSshPrivateKey() != "" {
		return invalid("use either an access token or an SSH key, not both")
	}
	return nil
}

// validateGitURL allows https:// (and http:// for local test servers
// without credentials), ssh:// and scp-like git@host:path addresses.
// Everything else (file://, ext::, local paths) could read the node.
func validateGitURL(raw string, ssh, token bool) error {
	if strings.HasPrefix(raw, "-") || strings.ContainsAny(raw, "\n\r\t\x00") {
		return invalid("%q is not a repository address", raw)
	}
	if scpRe.MatchString(raw) && !strings.Contains(raw, "://") {
		if !ssh {
			return invalid("%s is an SSH address: add an SSH key or use the https:// address", raw)
		}
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || strings.HasPrefix(u.Host, "-") {
		return invalid("%q is not a repository address", raw)
	}
	switch u.Scheme {
	case "https", "http":
		if u.User != nil {
			return invalid("put credentials in the access token, not in the repository address")
		}
		if ssh {
			return invalid("an SSH key needs an ssh:// or git@ address")
		}
		if token && u.Scheme == "http" {
			return invalid("an access token needs an https:// address: over http:// it would travel unencrypted")
		}
	case "ssh":
		if !ssh {
			return invalid("%s is an SSH address: add an SSH key or use the https:// address", raw)
		}
	default:
		return invalid("repository addresses start with https:// or ssh://")
	}
	return nil
}

// safeRelPath accepts "", "." and relative paths that stay inside their
// root lexically. Symlinks are checked again after the fetch.
func safeRelPath(p string) bool {
	if p == "" || p == "." {
		return true
	}
	if strings.ContainsAny(p, "\x00\n\r") || strings.HasPrefix(p, "/") {
		return false
	}
	c := path.Clean(p)
	return c != ".." && !strings.HasPrefix(c, "../")
}

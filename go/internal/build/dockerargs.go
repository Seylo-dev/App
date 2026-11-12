package build

import (
	"io"
	"os"
	"regexp"
	"slices"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// A Dockerfile build gets every variable as a BuildKit secret file and only
// the ones that are not secret as build args (splitEnv). An ARG whose name
// is a secret variable therefore stays empty, which reads like a missing
// variable: "/bin/sh: 1: NAME: is a required build arg". The build log
// says why before the build starts, and again as the last line when a
// failed build's output mentions the name. Only names are printed, never
// values.

// maxDockerfileRead bounds how much of a Dockerfile is read for its ARGs.
const maxDockerfileRead = 1 << 20

// secretArgNote is the log line for an ARG that names a secret variable.
func secretArgNote(name string) string {
	return name + " is a secret, so the build gets it as a BuildKit secret (RUN --mount=type=secret,id=" + name +
		"), not as ARG " + name + `. If it is not secret, add "# @public" above it in the service's environment.`
}

// secretArgs are the ARG names of the Dockerfile at path that are secret
// variables of env, in Dockerfile order; nil when the file cannot be read.
func secretArgs(path string, env []*agentv1.EnvVar) []string {
	secret := map[string]bool{}
	for _, e := range env {
		if e.GetSecret() {
			secret[e.GetName()] = true
		}
	}
	if len(secret) == 0 {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	text, err := io.ReadAll(io.LimitReader(f, maxDockerfileRead))
	if err != nil {
		return nil
	}
	var out []string
	for _, name := range dockerfileArgs(string(text)) {
		if secret[name] {
			out = append(out, name)
		}
	}
	return out
}

// mentionedSecretArgs are the names of args that a line of output mentions,
// leaving out the agent's own "--> " lines (the notes themselves).
func mentionedSecretArgs(output string, args []string) []string {
	if len(args) == 0 {
		return nil
	}
	var lines []string
	for _, line := range strings.Split(output, "\n") {
		if !strings.HasPrefix(line, "--> ") {
			lines = append(lines, line)
		}
	}
	text := strings.Join(lines, "\n")
	var out []string
	for _, name := range args {
		if regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\b`).MatchString(text) {
			out = append(out, name)
		}
	}
	return out
}

var (
	directiveRe = regexp.MustCompile(`^#\s*([A-Za-z]+)\s*=\s*(.*?)\s*$`)
	heredocRe   = regexp.MustCompile(`<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)(["']?)`)
)

type heredoc struct {
	word      string
	stripTabs bool
}

// dockerfileArgs returns the names the ARG instructions of a Dockerfile
// declare, every stage, in order, each once ("ARG A", "ARG B=default",
// "ARG C D=x"). It follows the escape directive, line continuations,
// comments and the heredocs of RUN, COPY and ADD, so a line inside a
// heredoc is not taken for an instruction.
func dockerfileArgs(text string) []string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	escape := byte('\\')
	// Parser directives come first; the first line that is not one ends them.
	for _, line := range lines {
		m := directiveRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			break
		}
		if strings.EqualFold(m[1], "escape") && (m[2] == "`" || m[2] == `\`) {
			escape = m[2][0]
		}
	}

	var (
		out       []string
		pending   []heredoc
		current   strings.Builder
		continued bool
	)
	instruction := func(line string) {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			return
		}
		switch strings.ToUpper(fields[0]) {
		case "ARG":
			rest := strings.TrimSpace(line[strings.Index(line, fields[0])+len(fields[0]):])
			for _, word := range shellWords(rest, escape) {
				name, _, _ := strings.Cut(word, "=")
				if envNameRe.MatchString(name) && !slices.Contains(out, name) {
					out = append(out, name)
				}
			}
		case "RUN", "COPY", "ADD":
			for _, m := range heredocRe.FindAllStringSubmatchIndex(line, -1) {
				// "<<<" is a here-string, not a heredoc; the quotes must match.
				if m[0] > 0 && line[m[0]-1] == '<' {
					continue
				}
				if line[m[4]:m[5]] != line[m[8]:m[9]] {
					continue
				}
				pending = append(pending, heredoc{word: line[m[6]:m[7]], stripTabs: m[3] > m[2]})
			}
		}
	}
	for _, raw := range lines {
		if len(pending) > 0 {
			doc := pending[0]
			end := raw
			if doc.stripTabs {
				end = strings.TrimLeft(end, "\t")
			}
			if end == doc.word {
				pending = pending[1:]
			}
			continue
		}
		trimmed := strings.TrimSpace(raw)
		// Comment lines are dropped, also between continued lines; so are
		// empty lines inside a continuation.
		if strings.HasPrefix(trimmed, "#") || (continued && trimmed == "") {
			continue
		}
		line := strings.TrimRight(raw, " \t")
		if line != "" && line[len(line)-1] == escape {
			current.WriteString(line[:len(line)-1])
			current.WriteByte(' ')
			continued = true
			continue
		}
		current.WriteString(line)
		continued = false
		instruction(current.String())
		current.Reset()
	}
	if current.Len() > 0 {
		instruction(current.String())
	}
	return out
}

// shellWords splits an instruction's arguments at unquoted white space,
// keeping quoted parts (ARG A="x y" B=1 is two words).
func shellWords(s string, escape byte) []string {
	var (
		words []string
		word  strings.Builder
		quote byte
		in    bool
	)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			} else if c == escape && quote == '"' && i+1 < len(s) {
				i++
				word.WriteByte(s[i])
			} else {
				word.WriteByte(c)
			}
		case c == '"' || c == '\'':
			quote, in = c, true
		case c == escape && i+1 < len(s):
			i++
			word.WriteByte(s[i])
			in = true
		case c == ' ' || c == '\t':
			if in {
				words = append(words, word.String())
				word.Reset()
				in = false
			}
		default:
			word.WriteByte(c)
			in = true
		}
	}
	if in {
		words = append(words, word.String())
	}
	return words
}

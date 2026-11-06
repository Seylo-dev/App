package panelapi

import (
	"fmt"
	"regexp"
	"strings"
)

var envKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)

// lineKey returns the variable a .env line assigns ("" for comments and
// blank lines). "export KEY=..." counts as KEY.
func lineKey(line string) string {
	t := strings.TrimSpace(line)
	if t == "" || strings.HasPrefix(t, "#") {
		return ""
	}
	t = strings.TrimPrefix(t, "export ")
	key, _, ok := strings.Cut(t, "=")
	if !ok {
		return ""
	}
	return strings.TrimSpace(key)
}

// quoteValue writes a value the way @seylo/env-analyzer's stringifyEnv
// does, so the panel reads it back unchanged: bare when simple, otherwise
// double-quoted. "$" is left alone so ${{svc.VAR}} references keep working.
func quoteValue(v string) string {
	if v == "" || bareValue.MatchString(v) {
		return v
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`)
	return `"` + r.Replace(v) + `"`
}

var bareValue = regexp.MustCompile("^[^\\s\"'`#\\\\]+$")

// SetVars changes or appends KEY=VALUE assignments in a .env text, keeping
// comments, order and every other line. A key assigned twice is updated in
// place where it is first set and later duplicates are removed.
func SetVars(text string, assignments []string) (string, error) {
	values := map[string]string{}
	var order []string
	for _, a := range assignments {
		key, value, ok := strings.Cut(a, "=")
		key = strings.TrimSpace(key)
		if !ok || !envKey.MatchString(key) {
			return "", fmt.Errorf("%q is not KEY=VALUE", a)
		}
		if _, seen := values[key]; !seen {
			order = append(order, key)
		}
		values[key] = value
	}
	lines := splitLines(text)
	done := map[string]bool{}
	out := lines[:0:0]
	for _, line := range lines {
		k := lineKey(line)
		if v, ok := values[k]; ok {
			if done[k] {
				continue
			}
			done[k] = true
			out = append(out, k+"="+quoteValue(v))
			continue
		}
		out = append(out, line)
	}
	for _, k := range order {
		if !done[k] {
			out = append(out, k+"="+quoteValue(values[k]))
		}
	}
	return joinLines(out), nil
}

// UnsetVars removes every assignment of keys. It reports the keys that
// were not set.
func UnsetVars(text string, keys []string) (string, []string) {
	drop := map[string]bool{}
	for _, k := range keys {
		drop[strings.TrimSpace(k)] = true
	}
	found := map[string]bool{}
	var out []string
	for _, line := range splitLines(text) {
		if k := lineKey(line); drop[k] {
			found[k] = true
			continue
		}
		out = append(out, line)
	}
	var missing []string
	for _, k := range keys {
		if !found[strings.TrimSpace(k)] {
			missing = append(missing, k)
		}
	}
	return joinLines(out), missing
}

func splitLines(text string) []string {
	text = strings.TrimRight(text, "\n")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func joinLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

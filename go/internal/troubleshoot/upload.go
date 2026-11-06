package troubleshoot

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Uploaded is the site's answer to POST /l.
type Uploaded struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	ExpiresAt   string `json:"expiresAt"`
	DeleteToken string `json:"deleteToken"`
}

// Finding is one line the site still considers a secret.
type Finding struct {
	Rule string `json:"rule"`
	Line int    `json:"line"`
}

// RefusedError: the site found what looks like a secret and refused the
// report. It names the rules and lines, never the values.
type RefusedError struct {
	Findings []Finding
}

func (e *RefusedError) Error() string {
	parts := make([]string, 0, len(e.Findings))
	for _, f := range e.Findings {
		parts = append(parts, fmt.Sprintf("%s on line %d", f.Rule, f.Line))
	}
	return "the site refused the report because it still looks like it holds a secret (" + strings.Join(parts, ", ") +
		"); run with --dry-run, check those lines, and report the miss"
}

// Upload posts the Markdown report to <siteURL>/l.
func Upload(ctx context.Context, client *http.Client, siteURL, markdown string) (*Uploaded, error) {
	endpoint := strings.TrimSuffix(siteURL, "/") + "/l"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(markdown))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "text/markdown; charset=utf-8")
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("uploading the report: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	switch res.StatusCode {
	case http.StatusCreated, http.StatusOK:
		var up Uploaded
		if err := json.Unmarshal(body, &up); err != nil || up.URL == "" {
			return nil, fmt.Errorf("uploading the report: unexpected answer from %s", endpoint)
		}
		return &up, nil
	case http.StatusUnprocessableEntity:
		var refused struct {
			Findings []Finding `json:"findings"`
		}
		_ = json.Unmarshal(body, &refused)
		return nil, &RefusedError{Findings: refused.Findings}
	case http.StatusRequestEntityTooLarge:
		return nil, fmt.Errorf("uploading the report: it is larger than the site accepts")
	case http.StatusTooManyRequests:
		return nil, fmt.Errorf("uploading the report: too many uploads from this address, try again in an hour")
	default:
		return nil, fmt.Errorf("uploading the report: HTTP %d from %s", res.StatusCode, endpoint)
	}
}

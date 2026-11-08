package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/signer"
)

// TestWritePresignVectors writes the URLs minio-go's own signer presigns
// for the requests a node makes with signed backups, and the Authorization
// headers it signs for the multipart steps the panel makes itself. The
// panel signs both (apps/panel/src/modules/backups/presign.ts) and its test
// checks it produces the same at the same time, so the panel's signer
// agrees with the client the agent used with the keys before. Regenerate with
// SEYLO_WRITE_PRESIGN_VECTORS=1 go test -run TestWritePresignVectors ./internal/backup/
func TestWritePresignVectors(t *testing.T) {
	if os.Getenv("SEYLO_WRITE_PRESIGN_VECTORS") == "" {
		t.Skip("set SEYLO_WRITE_PRESIGN_VECTORS=1 to regenerate the panel's presign vectors")
	}
	type dest struct {
		Endpoint  string `json:"endpoint"`
		Region    string `json:"region"`
		Bucket    string `json:"bucket"`
		PathStyle bool   `json:"pathStyle"`
	}
	type vector struct {
		Dest      dest              `json:"destination"`
		Method    string            `json:"method"`
		Key       string            `json:"key"`
		Query     map[string]string `json:"query"`
		ExpiresIn int               `json:"expiresIn"`
		URL       string            `json:"url"`
	}
	type headerVector struct {
		Dest          dest              `json:"destination"`
		Method        string            `json:"method"`
		Key           string            `json:"key"`
		Query         map[string]string `json:"query"`
		Body          string            `json:"body"`
		URL           string            `json:"url"`
		Date          string            `json:"date"`
		Authorization string            `json:"authorization"`
	}
	var headers []headerVector
	dests := []dest{
		{"http://127.0.0.1:9000", "us-east-1", "backups", true},
		{"https://0123456789abcdef.r2.cloudflarestorage.com", "auto", "backups", false},
		{"https://s3.eu-central-1.amazonaws.com", "eu-central-1", "seylo-backups", false},
		{"https://s3.amazonaws.com", "us-east-1", "my.dotted.bucket", false},
		{"https://minio.example.com:9443", "auto", "backups", false},
	}
	key := "seylo/a1b2c3d4/pol_1/20260101T030000Z-run_9.sql.gz"
	odd := "my backups/ünï code+plus=eq/20260101T030000Z-r.tar.gz"
	reqs := []struct {
		method string
		key    string
		query  map[string]string
	}{
		{"PUT", key, nil},
		{"GET", key, nil},
		{"DELETE", key, nil},
		{"POST", key, map[string]string{"uploads": ""}},
		{"PUT", key, map[string]string{"partNumber": "7", "uploadId": "VXBsb2FkIElEIGZvciA2aWWpbmcncyBteS1tb3ZpZS5tMnRzIHVwbG9hZA+/="}},
		{"POST", key, map[string]string{"uploadId": "abc~def_123"}},
		{"DELETE", key, map[string]string{"uploadId": "abc~def_123"}},
		{"GET", "", map[string]string{"list-type": "2", "prefix": "seylo/a1b2c3d4/pol_1/", "continuation-token": "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM="}},
		{"PUT", odd, nil},
	}
	var out []vector
	for _, d := range dests {
		u, err := url.Parse(d.Endpoint)
		if err != nil {
			t.Fatal(err)
		}
		lookup := minio.BucketLookupAuto
		if d.PathStyle {
			lookup = minio.BucketLookupPath
		}
		c, err := minio.New(u.Host, &minio.Options{
			Creds:  credentials.NewStaticV4("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", ""),
			Secure: u.Scheme == "https", Region: d.Region, BucketLookup: lookup,
		})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range reqs {
			params := url.Values{}
			for k, v := range r.query {
				params.Set(k, v)
			}
			signed, err := c.Presign(context.Background(), r.method, d.Bucket, r.key, time.Hour, params)
			if err != nil {
				t.Fatalf("%s %s %s: %v", d.Endpoint, r.method, r.key, err)
			}
			q := r.query
			if q == nil {
				q = map[string]string{}
			}
			out = append(out, vector{Dest: d, Method: r.method, Key: r.key, Query: q, ExpiresIn: 3600, URL: signed.String()})
		}
		for _, r := range []struct {
			method string
			query  map[string]string
			body   string
		}{
			{"POST", map[string]string{"uploads": ""}, ""},
			{"POST", map[string]string{"uploadId": "abc~def/123="}, "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>\"e1\"</ETag></Part></CompleteMultipartUpload>"},
			{"DELETE", map[string]string{"uploadId": "abc~def/123="}, ""},
		} {
			params := url.Values{}
			for k, v := range r.query {
				params.Set(k, v)
			}
			// minio-go's addressing, then its header signer on that URL.
			target, err := c.Presign(context.Background(), r.method, d.Bucket, key, time.Hour, params)
			if err != nil {
				t.Fatal(err)
			}
			q := target.Query()
			for k := range q {
				if strings.HasPrefix(k, "X-Amz-") {
					q.Del(k)
				}
			}
			target.RawQuery = strings.ReplaceAll(q.Encode(), "+", "%20")
			req, err := http.NewRequest(r.method, target.String(), strings.NewReader(r.body))
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256([]byte(r.body))
			req.Header.Set("X-Amz-Content-Sha256", hex.EncodeToString(sum[:]))
			signed := signer.SignV4(*req, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "", d.Region)
			headers = append(headers, headerVector{Dest: d, Method: r.method, Key: key, Query: r.query, Body: r.body, URL: target.String(),
				Date: signed.Header.Get("X-Amz-Date"), Authorization: signed.Header.Get("Authorization")})
		}
	}
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(map[string]any{"presigned": out, "headerSigned": headers}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("..", "..", "..", "apps", "panel", "test", "fixtures", "s3-presign-vectors.json")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %d presigned and %d header-signed vectors to %s", len(out), len(headers), strings.TrimPrefix(path, "../../../"))
}

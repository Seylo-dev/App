package geoip

import (
	"archive/tar"
	"bytes"
	"cmp"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/internal/netguard"
)

// Sources of the country database.
const (
	// SourceDBIP is DB-IP's IP to Country Lite: free, no account, a new
	// file every month, CC BY 4.0 (attribution: "IP Geolocation by DB-IP",
	// https://db-ip.com).
	SourceDBIP = "dbip"
	// SourceMaxMind is MaxMind's GeoLite2 Country, which needs a free
	// account and a license key, updated twice a week. Used only when
	// DB-IP cannot be downloaded and an account is set.
	SourceMaxMind = "maxmind"
)

// Attribution is the credit DB-IP's licence asks for.
const Attribution = "IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0"

// Default download locations. %s is the month, "2026-11".
const (
	DefaultDBIPURL    = "https://download.db-ip.com/free/dbip-country-lite-%s.mmdb.gz"
	DefaultMaxMindURL = "https://download.maxmind.com/geoip/databases/GeoLite2-Country/download"
)

// Refresh timing.
const (
	// RefreshInterval is how often the agent asks whether a database is
	// due. A DB-IP file is due once a new month started (DB-IP publishes
	// on the 1st); a GeoLite2 file after MaxMindMaxAge.
	RefreshInterval = 6 * time.Hour
	// MaxMindMaxAge is how old a GeoLite2 file gets before the next
	// download (DB-IP is tried first).
	MaxMindMaxAge = 7 * 24 * time.Hour
	// maxDownload bounds a compressed download.
	maxDownload = 96 << 20
)

// MaxMind is a MaxMind account for GeoLite2 downloads.
type MaxMind struct {
	AccountID  string
	LicenseKey string
}

// Set reports whether both parts are there.
func (m MaxMind) Set() bool { return m.AccountID != "" && m.LicenseKey != "" }

// State is what the agent keeps about the installed database (state.json
// next to it).
type State struct {
	Source string `json:"source,omitempty"`
	// Month is the DB-IP file's month ("2026-11").
	Month string `json:"month,omitempty"`
	// Type and Built are the file's own metadata.
	Type  string    `json:"type,omitempty"`
	Built time.Time `json:"built,omitzero"`
	// SHA256 of the installed file.
	SHA256      string    `json:"sha256,omitempty"`
	InstalledAt time.Time `json:"installed_at,omitzero"`
	// LastError is why the last download failed, empty after one worked.
	LastError   string    `json:"last_error,omitempty"`
	LastErrorAt time.Time `json:"last_error_at,omitzero"`
}

// Fetcher downloads, checks and installs the country database.
type Fetcher struct {
	// Dir holds country.mmdb and state.json (<datadir>/geoip).
	Dir string
	// Client makes the downloads; nil is a client that only connects to
	// public addresses.
	Client *http.Client
	// UserAgent for the downloads.
	UserAgent string
	// DBIPURL and MaxMindURL override the defaults (tests).
	DBIPURL, MaxMindURL string
	// MinNodes is the fewest search tree nodes a real database has; 0
	// means 10000 (DB-IP's and MaxMind's country files have hundreds of
	// thousands). Tests with tiny databases set -1.
	MinNodes int
	Now      func() time.Time
	Logger   *slog.Logger
}

// Path is the installed database file.
func (f *Fetcher) Path() string { return filepath.Join(f.Dir, "country.mmdb") }

func (f *Fetcher) statePath() string { return filepath.Join(f.Dir, "state.json") }

func (f *Fetcher) now() time.Time {
	if f.Now != nil {
		return f.Now().UTC()
	}
	return time.Now().UTC()
}

func (f *Fetcher) log() *slog.Logger {
	if f.Logger == nil {
		return slog.New(slog.DiscardHandler)
	}
	return f.Logger
}

func (f *Fetcher) client() *http.Client {
	if f.Client != nil {
		return f.Client
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = netguard.Dialer(15*time.Second, false).DialContext
	return &http.Client{Timeout: 5 * time.Minute, Transport: tr}
}

// State reads state.json; a missing one is the zero State.
func (f *Fetcher) State() (State, error) {
	var st State
	data, err := os.ReadFile(f.statePath())
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(data, &st); err != nil {
		return State{}, fmt.Errorf("reading %s: %w", f.statePath(), err)
	}
	return st, nil
}

func (f *Fetcher) saveState(st State) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(f.statePath(), append(data, '\n'), 0o644)
}

// Due reports whether a download is due: no usable database, a DB-IP file
// from before this month, a GeoLite2 file older than MaxMindMaxAge, or
// one from a source this agent does not know.
func (f *Fetcher) Due() bool {
	st, err := f.State()
	if err != nil {
		return true
	}
	if _, err := os.Stat(f.Path()); err != nil {
		return true
	}
	now := f.now()
	switch st.Source {
	case SourceDBIP:
		return st.Month < now.Format("2006-01")
	case SourceMaxMind:
		return now.Sub(st.InstalledAt) > MaxMindMaxAge
	}
	return true
}

// Refresh downloads and installs a database when one is due (Due): DB-IP's
// file of this month (last month's while this month's is not out and no
// database is installed), else GeoLite2 when mm is set. The installed file
// stays when every download fails. updated says a new file is in place.
func (f *Fetcher) Refresh(ctx context.Context, mm MaxMind) (updated bool, err error) {
	if !f.Due() {
		return false, nil
	}
	if err := os.MkdirAll(f.Dir, 0o755); err != nil {
		return false, err
	}
	st, _ := f.State()
	_, statErr := os.Stat(f.Path())
	installed := statErr == nil

	now := f.now()
	months := []string{now.Format("2006-01")}
	if !installed {
		months = append(months, now.AddDate(0, 0, -now.Day()).Format("2006-01"))
	}
	var errs []error
	for _, month := range months {
		data, err := f.downloadDBIP(ctx, month)
		if err == nil {
			err = f.install(data, State{Source: SourceDBIP, Month: month})
		}
		if err == nil {
			return true, nil
		}
		errs = append(errs, fmt.Errorf("DB-IP %s: %w", month, err))
		if !errors.Is(err, errNotPublished) {
			break
		}
	}
	notOut := len(errs) == 1 && errors.Is(errs[0], errNotPublished) && installed && st.Source == SourceDBIP
	if mm.Set() && !notOut {
		data, err := f.downloadMaxMind(ctx, mm)
		if err == nil {
			err = f.install(data, State{Source: SourceMaxMind})
		}
		if err == nil {
			return true, nil
		}
		errs = append(errs, fmt.Errorf("MaxMind GeoLite2: %w", err))
	}
	err = errors.Join(errs...)
	if notOut {
		// This month's file is not out yet (DB-IP publishes during the
		// first day or two); last month's stays and the next pass asks again.
		f.log().Info("this month's country database is not published yet; keeping the installed one", "month", months[0])
		err = nil
	}
	if err != nil {
		st.LastError, st.LastErrorAt = err.Error(), now
		if serr := f.saveState(st); serr != nil {
			f.log().Warn("saving the country database state", "err", serr)
		}
	}
	return false, err
}

var errNotPublished = errors.New("not published")

func (f *Fetcher) get(ctx context.Context, url string, auth *MaxMind) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if f.UserAgent != "" {
		req.Header.Set("User-Agent", f.UserAgent)
	}
	if auth != nil {
		req.SetBasicAuth(auth.AccountID, auth.LicenseKey)
	}
	// Go drops the Authorization header when a redirect leaves the host
	// (MaxMind redirects to its storage).
	resp, err := f.client().Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, errNotPublished
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return nil, fmt.Errorf("%s answered %s (check the account ID and license key)", req.URL.Host, resp.Status)
		}
		return nil, fmt.Errorf("%s answered %s", req.URL.Host, resp.Status)
	}
	return resp, nil
}

// downloadDBIP fetches and unpacks DB-IP's file for month.
func (f *Fetcher) downloadDBIP(ctx context.Context, month string) ([]byte, error) {
	url := fmt.Sprintf(cmp.Or(f.DBIPURL, DefaultDBIPURL), month)
	resp, err := f.get(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	zr, err := gzip.NewReader(io.LimitReader(resp.Body, maxDownload))
	if err != nil {
		return nil, fmt.Errorf("unpacking: %w", err)
	}
	data, err := io.ReadAll(io.LimitReader(zr, MaxDatabaseSize+1))
	if err != nil {
		return nil, fmt.Errorf("unpacking: %w", err)
	}
	return data, nil
}

// downloadMaxMind fetches GeoLite2 Country (tar.gz), checks it against
// MaxMind's SHA-256 and takes the .mmdb out.
func (f *Fetcher) downloadMaxMind(ctx context.Context, mm MaxMind) ([]byte, error) {
	base := cmp.Or(f.MaxMindURL, DefaultMaxMindURL)
	sumResp, err := f.get(ctx, base+"?suffix=tar.gz.sha256", &mm)
	if err != nil {
		return nil, fmt.Errorf("checksum: %w", err)
	}
	sumText, err := io.ReadAll(io.LimitReader(sumResp.Body, 4096))
	sumResp.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("checksum: %w", err)
	}
	fields := strings.Fields(string(sumText))
	if len(fields) == 0 || len(fields[0]) != 64 {
		return nil, errors.New("checksum: no SHA-256 in the answer")
	}
	want, err := hex.DecodeString(fields[0])
	if err != nil {
		return nil, fmt.Errorf("checksum: %w", err)
	}
	resp, err := f.get(ctx, base+"?suffix=tar.gz", &mm)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	archive, err := io.ReadAll(io.LimitReader(resp.Body, maxDownload+1))
	if err != nil {
		return nil, err
	}
	if len(archive) > maxDownload {
		return nil, errors.New("the download is too large")
	}
	if got := sha256.Sum256(archive); !bytes.Equal(got[:], want) {
		return nil, errors.New("the download does not match MaxMind's SHA-256")
	}
	zr, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("unpacking: %w", err)
	}
	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, errors.New("the archive has no .mmdb file")
		}
		if err != nil {
			return nil, fmt.Errorf("unpacking: %w", err)
		}
		if h.Typeflag != tar.TypeReg || path.Ext(h.Name) != ".mmdb" {
			continue
		}
		if h.Size > MaxDatabaseSize {
			return nil, errors.New("the database in the archive is too large")
		}
		return io.ReadAll(io.LimitReader(tr, MaxDatabaseSize+1))
	}
}

// install checks data (a country database, every record readable, a
// believable size) and puts it in place atomically, then the state.
func (f *Fetcher) install(data []byte, st State) error {
	db, err := Open(data)
	if err != nil {
		return err
	}
	if err := db.Verify(); err != nil {
		return err
	}
	minNodes := f.MinNodes
	if minNodes == 0 {
		minNodes = 10000
	}
	if nodes := int(db.r.Metadata.NodeCount); minNodes > 0 && nodes < minNodes {
		return fmt.Errorf("the database has %d search tree nodes, fewer than the %d of a real country database", nodes, minNodes)
	}
	if err := writeAtomic(f.Path(), data, 0o644); err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	i := db.Info()
	st.Type, st.Built, st.SHA256, st.InstalledAt = i.Type, i.Built, hex.EncodeToString(sum[:]), f.now()
	if err := f.saveState(st); err != nil {
		return err
	}
	f.log().Info("country database installed", "source", st.Source, "type", st.Type, "built", st.Built.Format(time.DateOnly), "bytes", len(data))
	return nil
}

// writeAtomic writes data to a temporary file next to path, syncs it and
// renames it over path.
func writeAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

package volumes

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/seylo-dev/app/go/internal/datadir"
)

// specialTree makes a sticky shared folder, a setgid folder and a setuid
// and a setgid program under dir.
func specialTree(t *testing.T, dir string) {
	t.Helper()
	for name, mode := range map[string]fs.FileMode{"shared": 0o777 | fs.ModeSticky, "group": 0o775 | fs.ModeSetgid} {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(dir, name), mode); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite(t, filepath.Join(dir, "suid"), "#!/bin/sh\n", 0o755)
	mustWrite(t, filepath.Join(dir, "sgid"), "#!/bin/sh\n", 0o755)
	if err := os.Chmod(filepath.Join(dir, "suid"), 0o755|fs.ModeSetuid); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(dir, "sgid"), 0o755|fs.ModeSetgid); err != nil {
		t.Fatal(err)
	}
}

// checkSpecialModes asserts what specialTree looks like once extracted:
// sticky and setgid on folders survive, setuid and setgid on files do not.
func checkSpecialModes(t *testing.T, dir string) {
	t.Helper()
	want := map[string]fs.FileMode{
		"shared": fs.ModeDir | 0o777 | fs.ModeSticky,
		"group":  fs.ModeDir | 0o775 | fs.ModeSetgid,
		"suid":   0o755,
		"sgid":   0o755,
	}
	for name, mode := range want {
		st, err := os.Lstat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode() != mode {
			t.Errorf("%s: mode %v, want %v", name, st.Mode(), mode)
		}
	}
}

func TestImportKeepsStickyAndFolderSetgid(t *testing.T) {
	ctx := context.Background()
	src := &Transfer{Layout: datadir.New(t.TempDir())}
	dir, _ := src.Layout.ServiceVolume("svc", "data")
	specialTree(t, dir)
	var buf bytes.Buffer
	if _, err := src.Export(ctx, "svc", "data", &buf); err != nil {
		t.Fatal(err)
	}
	dst := &Transfer{Layout: datadir.New(t.TempDir())}
	if _, err := dst.Import(ctx, "svc", "svc", "data", ImportOptions{}, bytes.NewReader(buf.Bytes())); err != nil {
		t.Fatal(err)
	}
	out, _ := dst.Layout.ServiceVolume("svc", "data")
	checkSpecialModes(t, out)
}

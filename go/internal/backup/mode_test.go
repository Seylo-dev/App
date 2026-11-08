package backup

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// A restore keeps the sticky bit on shared folders and setgid on folders
// (they were lost: the mask used fs.FileMode bit positions on tar's unix
// bits), and drops setuid and setgid on files like uploads do.
func TestRestoreKeepsStickyAndFolderSetgid(t *testing.T) {
	src := t.TempDir()
	for name, mode := range map[string]fs.FileMode{"shared": 0o777 | fs.ModeSticky, "group": 0o775 | fs.ModeSetgid} {
		if err := os.Mkdir(filepath.Join(src, name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(src, name), mode); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(src, "suid"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(src, "suid"), 0o755|fs.ModeSetuid|fs.ModeSetgid); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := writeArchive(context.Background(), src, &buf); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	if err := extractArchive(context.Background(), bytes.NewReader(buf.Bytes()), dst); err != nil {
		t.Fatal(err)
	}
	want := map[string]fs.FileMode{
		"shared": fs.ModeDir | 0o777 | fs.ModeSticky,
		"group":  fs.ModeDir | 0o775 | fs.ModeSetgid,
		"suid":   0o755,
	}
	for name, mode := range want {
		st, err := os.Lstat(filepath.Join(dst, name))
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode() != mode {
			t.Errorf("%s: mode %v, want %v", name, st.Mode(), mode)
		}
	}
}

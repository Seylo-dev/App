// Command brandgen turns brand/brand.json into Go constants, TypeScript
// constants and installer shell variables, so a rename is a one-file change.
//
// Usage (from the repository root):
//
//	go -C tools/brandgen run . -root ../..          write generated files
//	go -C tools/brandgen run . -root ../.. -check   exit 1 when they are stale
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

func main() {
	root := flag.String("root", ".", "repository root")
	check := flag.Bool("check", false, "report stale generated files instead of writing them")
	flag.Parse()

	if err := run(*root, *check); err != nil {
		fmt.Fprintln(os.Stderr, "brandgen:", err)
		os.Exit(1)
	}
}

func run(root string, check bool) error {
	data, err := os.ReadFile(filepath.Join(root, "brand", "brand.json"))
	if err != nil {
		return err
	}
	b, err := ParseBrand(data)
	if err != nil {
		return err
	}
	outputs, err := Render(b)
	if err != nil {
		return err
	}
	if check {
		return checkOutputs(root, outputs)
	}
	return writeOutputs(root, outputs)
}

func writeOutputs(root string, outputs []Output) error {
	for _, o := range outputs {
		target := filepath.Join(root, filepath.FromSlash(o.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, o.Content, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// ErrStale is returned by -check when any generated file differs from what
// brand.json would produce.
var ErrStale = errors.New("generated brand files are stale, run `make gen`")

func checkOutputs(root string, outputs []Output) error {
	var stale []string
	for _, o := range outputs {
		current, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(o.Path)))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if !bytes.Equal(current, o.Content) {
			stale = append(stale, o.Path)
		}
	}
	if len(stale) == 0 {
		return nil
	}
	return fmt.Errorf("%w: %v", ErrStale, stale)
}

package build

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// PruneCache empties the BuildKit cache of every builder of ours (one per
// project; never Docker's machine-wide cache). With dryRun it only reports
// what would be freed. It implements cleanup.CachePruner for the Prune RPC.
func (s *Service) PruneCache(ctx context.Context, dryRun bool) (uint64, []string, error) {
	names, err := s.buildx.ours(ctx)
	if err != nil || len(names) == 0 {
		// No buildx or no builder yet: no cache of ours.
		return 0, nil, nil
	}
	if !dryRun {
		if running, _ := s.queue.Stats(); running > 0 {
			return 0, []string{"build cache: skipped, a build is running"}, nil
		}
	}
	var total uint64
	var notes []string
	for _, name := range names {
		if dryRun {
			out, err := s.cli.out(ctx, "buildx", "du", "--builder", name)
			if err != nil {
				return total, notes, fmt.Errorf("reading the build cache size of %s: %w", name, err)
			}
			n := summaryBytes(out, "Reclaimable")
			total += n
			notes = append(notes, fmt.Sprintf("build cache of %s: %s reclaimable", name, humanBytes(n)))
			continue
		}
		out, err := s.cli.out(ctx, "buildx", "prune", "--builder", name, "--all", "--force")
		if err != nil {
			return total, notes, fmt.Errorf("pruning the build cache of %s: %w", name, err)
		}
		n := summaryBytes(out, "Total")
		total += n
		notes = append(notes, fmt.Sprintf("build cache of %s: %s freed", name, humanBytes(n)))
	}
	return total, notes, nil
}

var sizeRe = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)\s*([kKMGTP]?i?B)$`)

// summaryBytes reads a "Total:  1.2GB" style line of buildx output.
func summaryBytes(out, label string) uint64 {
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(k) != label {
			continue
		}
		return parseSize(strings.TrimSpace(v))
	}
	return 0
}

// parseSize reads Docker's human sizes ("0B", "12.5kB", "1.2GB"; decimal
// units, binary with "i").
func parseSize(s string) uint64 {
	m := sizeRe.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0
	}
	unit := strings.ToUpper(m[2])
	base := 1000.0
	if strings.Contains(unit, "I") {
		base = 1024
	}
	exp := strings.Index("BKMGTP", unit[:1])
	if exp < 0 {
		exp = 0
	}
	for range exp {
		f *= base
	}
	return uint64(f)
}

func humanBytes(n uint64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := uint64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(n)/float64(div), "kMGTP"[exp])
}

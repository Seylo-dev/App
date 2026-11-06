//go:build !unix

package agent

import "errors"

func diskUsage(string) (total, free uint64) { return 0, 0 }

func fsUsage(string) (fsUse, error) { return fsUse{}, errors.ErrUnsupported }

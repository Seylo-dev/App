package state

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// ErrCorruptDesired means the stored desired state could not be decoded.
// Load moved the file aside and returned an empty state; the agent asks
// the panel for a fresh one.
var ErrCorruptDesired = errors.New("state: stored desired state is unreadable")

// FileDesiredStore keeps the desired state in one protobuf file (mode
// 0600: it holds env values and other secrets).
type FileDesiredStore struct {
	path string
}

var _ DesiredStore = (*FileDesiredStore)(nil)

// NewFileDesiredStore stores the desired state at path.
func NewFileDesiredStore(path string) *FileDesiredStore { return &FileDesiredStore{path: path} }

// Load implements DesiredStore. A missing file is an empty state. An
// unreadable one is renamed to <path>.corrupt and Load returns an empty
// state together with ErrCorruptDesired.
func (s *FileDesiredStore) Load(ctx context.Context) (*agentv1.DesiredState, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return &agentv1.DesiredState{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading desired state: %w", err)
	}
	d := &agentv1.DesiredState{}
	if err := proto.Unmarshal(b, d); err != nil {
		_ = os.Rename(s.path, s.path+".corrupt")
		return &agentv1.DesiredState{}, fmt.Errorf("%w: %v", ErrCorruptDesired, err)
	}
	return d, nil
}

// Save implements DesiredStore.
func (s *FileDesiredStore) Save(ctx context.Context, desired *agentv1.DesiredState) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(desired)
	if err != nil {
		return fmt.Errorf("encoding desired state: %w", err)
	}
	if err := WriteFileAtomic(s.path, b, 0o600); err != nil {
		return fmt.Errorf("saving desired state: %w", err)
	}
	return nil
}

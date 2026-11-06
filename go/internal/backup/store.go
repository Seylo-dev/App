package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Store is the S3-compatible bucket a backup goes to. Keys are full object
// keys (prefix included).
type Store interface {
	// Put streams r to key with multipart uploads (the size is unknown)
	// and returns the bytes written. A failed upload leaves no object.
	Put(ctx context.Context, key string, r io.Reader) (int64, error)
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	List(ctx context.Context, prefix string) ([]Object, error)
	Delete(ctx context.Context, key string) error
}

// Object is one listed object.
type Object struct {
	Key          string
	Size         int64
	LastModified time.Time
}

// partSize bounds memory per upload (minio buffers one part) and allows
// objects up to 10000 parts * 32 MiB = 312 GiB.
const partSize = 32 << 20

// S3Store is a Store on minio-go, which speaks AWS S3, Cloudflare R2,
// MinIO, Backblaze B2 and other S3-compatible services.
type S3Store struct {
	client *minio.Client
	bucket string
}

// OpenS3 opens the destination's bucket. An empty endpoint means AWS S3.
func OpenS3(dest *agentv1.BackupDestination) (*S3Store, error) {
	if dest.GetBucket() == "" {
		return nil, errors.New("backup destination has no bucket")
	}
	host, secure := "s3.amazonaws.com", true
	if e := strings.TrimSpace(dest.GetEndpoint()); e != "" {
		if !strings.Contains(e, "://") {
			e = "https://" + e
		}
		u, err := url.Parse(e)
		if err != nil || u.Host == "" {
			return nil, fmt.Errorf("backup destination endpoint %q is not a URL", dest.GetEndpoint())
		}
		if u.Path != "" && u.Path != "/" {
			return nil, fmt.Errorf("backup destination endpoint %q must not have a path; put the bucket in the bucket field", dest.GetEndpoint())
		}
		host, secure = u.Host, u.Scheme != "http"
	}
	lookup := minio.BucketLookupAuto
	if dest.GetPathStyle() {
		lookup = minio.BucketLookupPath
	}
	region := dest.GetRegion()
	// R2 wants "auto"; minio would otherwise probe the bucket location.
	if region == "" && strings.HasSuffix(host, ".r2.cloudflarestorage.com") {
		region = "auto"
	}
	c, err := minio.New(host, &minio.Options{
		Creds:        credentials.NewStaticV4(dest.GetAccessKeyId(), dest.GetSecretAccessKey(), ""),
		Secure:       secure,
		Region:       region,
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, fmt.Errorf("opening backup destination: %w", err)
	}
	return &S3Store{client: c, bucket: dest.GetBucket()}, nil
}

// Put implements Store.
func (s *S3Store) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	info, err := s.client.PutObject(ctx, s.bucket, key, r, -1, minio.PutObjectOptions{
		PartSize:    partSize,
		ContentType: "application/octet-stream",
	})
	if err != nil {
		// Do not leave paid-for parts of an aborted multipart upload.
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		_ = s.client.RemoveIncompleteUpload(cctx, s.bucket, key)
		return 0, fmt.Errorf("uploading %s: %w", key, err)
	}
	return info.Size, nil
}

// Get implements Store.
func (s *S3Store) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("downloading %s: %w", key, err)
	}
	// GetObject is lazy; Stat surfaces a missing key now instead of on the
	// first read.
	if _, err := obj.Stat(); err != nil {
		obj.Close()
		if minio.ToErrorResponse(err).Code == minio.NoSuchKey {
			return nil, fmt.Errorf("%w: %s", ErrObjectNotFound, key)
		}
		return nil, fmt.Errorf("downloading %s: %w", key, err)
	}
	return obj, nil
}

// List implements Store.
func (s *S3Store) List(ctx context.Context, prefix string) ([]Object, error) {
	var out []Object
	for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if o.Err != nil {
			return nil, fmt.Errorf("listing %s: %w", prefix, o.Err)
		}
		out = append(out, Object{Key: o.Key, Size: o.Size, LastModified: o.LastModified})
	}
	return out, nil
}

// Delete implements Store.
func (s *S3Store) Delete(ctx context.Context, key string) error {
	if err := s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("deleting %s: %w", key, err)
	}
	return nil
}

// ErrObjectNotFound means a restore asked for a key that is not there.
var ErrObjectNotFound = errors.New("backup object not found")

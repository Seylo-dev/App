package backup

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// SignedCapability is advertised by agents that take a destination without
// keys and ask the panel to presign each request (BackupDestination.signing_id).
const SignedCapability = "backup.signed.v1"

// Signer presigns the storage requests of one backup or restore
// (PanelService.SignBackupRequests; *rpc.PanelClient in the agent).
type Signer interface {
	SignBackupRequests(ctx context.Context, req *agentv1.SignBackupRequestsRequest) (*agentv1.SignBackupRequestsResponse, error)
}

// SignedStore is the Store of a destination that came without keys
// (BackupDestination.signing_id): the panel presigns the PUT, UploadPart,
// GET and DELETE requests of this run and the node sends them straight to
// the bucket; the multipart create, complete and abort steps the panel
// makes itself. The node never holds a key, so it reaches only its run's
// own object. Retention is the panel's (List is not available).
type SignedStore struct {
	signer   Signer
	id       string
	client   *http.Client
	partSize int
}

// maxParts is S3's limit on the parts of one multipart upload.
const maxParts = 10000

// signedClient sends presigned requests. No overall timeout (an object can
// take hours), but connecting and waiting for the answer to a sent request
// are bounded. Redirects are not followed: a presigned URL is only valid
// for its own host, and the S3 error says more than the redirect.
var signedClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 5 * time.Minute,
		ExpectContinueTimeout: time.Second,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// OpenSigned returns the store of a keyless destination.
func OpenSigned(signer Signer, dest *agentv1.BackupDestination) (*SignedStore, error) {
	if signer == nil {
		return nil, errors.New("this agent has no panel connection to sign backup requests")
	}
	if !segmentRe.MatchString(dest.GetSigningId()) {
		return nil, fmt.Errorf("signing id %q is not valid", dest.GetSigningId())
	}
	return &SignedStore{signer: signer, id: dest.GetSigningId(), client: signedClient, partSize: partSize}, nil
}

// panelRetries: while the panel is unreachable (the agent reconnecting) or
// busy, a step is asked again for about half a minute before the backup
// fails.
var panelRetries = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second}

// step asks the panel for one step: a presigned request, or the result of
// a step the panel made itself. The panel refusing (PERMISSION_DENIED and
// the like) is final; UNAVAILABLE and RESOURCE_EXHAUSTED are retried. The
// multipart completion is not: a lost answer to one that worked would fail
// the retry.
func (s *SignedStore) step(ctx context.Context, req *agentv1.BackupStorageRequest) (*agentv1.SignedStorageRequest, error) {
	call := &agentv1.SignBackupRequestsRequest{SigningId: s.id, Requests: []*agentv1.BackupStorageRequest{req}}
	resp, err := s.signer.SignBackupRequests(ctx, call)
	for _, wait := range panelRetries {
		code := rpc.StatusOf(err).GetCode()
		retry := code == agentv1.StatusCode_STATUS_CODE_UNAVAILABLE || code == agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED
		if err == nil || !retry || req.GetOp() == agentv1.BackupStorageOp_BACKUP_STORAGE_OP_COMPLETE_MULTIPART {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		// Scaled by retryDelay (a second; tests shorten it).
		case <-time.After(time.Duration(float64(wait) * retryDelay.Seconds())):
		}
		resp, err = s.signer.SignBackupRequests(ctx, call)
	}
	if err != nil {
		return nil, fmt.Errorf("the panel refused or failed the request: %w", err)
	}
	if len(resp.GetRequests()) != 1 {
		return nil, errors.New("the panel answered without the request")
	}
	return resp.GetRequests()[0], nil
}

// attempts and retryDelay: a request the bucket answers with 5xx or 429,
// or that fails on the network, is signed and sent again (minio-go retried
// too). Every request here is idempotent: whole objects, parts, GET, DELETE.
var (
	attempts   = 4
	retryDelay = time.Second
)

// do signs req and sends it with body (nil for none), retrying transient
// failures.
func (s *SignedStore) do(ctx context.Context, req *agentv1.BackupStorageRequest, body []byte) (*http.Response, error) {
	delay := retryDelay
	for attempt := 1; ; attempt++ {
		resp, err := s.send(ctx, req, body)
		var ns notSent
		transient := err != nil && !errors.As(err, &ns) && ctx.Err() == nil
		if err == nil && (resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests) {
			transient = true
		}
		if !transient || attempt == attempts {
			return resp, err
		}
		if resp != nil {
			drain(resp)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
		delay *= 2
	}
}

// notSent marks a failure before anything reached the bucket (the panel
// refused or could not sign): retrying would not help.
type notSent struct{ error }

func (n notSent) Unwrap() error { return n.error }

func (s *SignedStore) send(ctx context.Context, req *agentv1.BackupStorageRequest, body []byte) (*http.Response, error) {
	signed, err := s.step(ctx, req)
	if err != nil {
		return nil, notSent{err}
	}
	if signed.GetUrl() == "" {
		return nil, notSent{errors.New("the panel answered without a signed request")}
	}
	var r io.Reader
	switch {
	case body == nil:
	case len(body) == 0:
		// A known empty body: a 0-length reader would go out chunked, which
		// S3 refuses for PUT.
		r = http.NoBody
	default:
		r = bytes.NewReader(body)
	}
	hreq, err := http.NewRequestWithContext(ctx, signed.GetMethod(), signed.GetUrl(), r)
	if err != nil {
		return nil, notSent{fmt.Errorf("the panel signed a request this agent cannot send: %w", err)}
	}
	if body != nil {
		hreq.ContentLength = int64(len(body))
		hreq.Header.Set("Content-Type", "application/octet-stream")
	}
	return s.client.Do(hreq)
}

// s3Error is the XML error body of S3-compatible services.
type s3Error struct {
	Code    string `xml:"Code"`
	Message string `xml:"Message"`
}

// statusError reads a failed response into an error and closes it.
func statusError(resp *http.Response, what string) error {
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var e s3Error
	if xml.Unmarshal(b, &e) == nil && e.Code != "" {
		if e.Message != "" {
			return fmt.Errorf("%s: %s (%s)", what, e.Message, e.Code)
		}
		return fmt.Errorf("%s: %s", what, e.Code)
	}
	return fmt.Errorf("%s: HTTP %d", what, resp.StatusCode)
}

// drain closes a response we only needed the status of.
func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
}

// Put implements Store: one PUT when the stream fits in a part, else a
// multipart upload (aborted when anything fails, so no paid-for parts are
// left behind).
func (s *SignedStore) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	buf := make([]byte, s.partSize)
	n, err := io.ReadFull(r, buf)
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		resp, err := s.do(ctx, &agentv1.BackupStorageRequest{Op: agentv1.BackupStorageOp_BACKUP_STORAGE_OP_PUT, Key: key}, buf[:n])
		if err != nil {
			return 0, fmt.Errorf("uploading %s: %w", key, err)
		}
		if resp.StatusCode/100 != 2 {
			return 0, statusError(resp, "uploading "+key)
		}
		drain(resp)
		return int64(n), nil
	}
	if err != nil {
		return 0, err
	}
	uploadID, err := s.createUpload(ctx, key)
	if err != nil {
		return 0, fmt.Errorf("uploading %s: %w", key, err)
	}
	total, err := s.uploadParts(ctx, key, uploadID, r, buf)
	if err != nil {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		s.abort(cctx, key, uploadID)
		return 0, fmt.Errorf("uploading %s: %w", key, err)
	}
	return total, nil
}

// createUpload asks the panel to start the multipart upload (it makes the
// request itself: not every provider takes it presigned).
func (s *SignedStore) createUpload(ctx context.Context, key string) (string, error) {
	signed, err := s.step(ctx, &agentv1.BackupStorageRequest{Op: agentv1.BackupStorageOp_BACKUP_STORAGE_OP_CREATE_MULTIPART, Key: key})
	if err != nil {
		return "", fmt.Errorf("starting the upload: %w", err)
	}
	if signed.GetUploadId() == "" {
		return "", errors.New("starting the upload: the panel answered without an upload id")
	}
	return signed.GetUploadId(), nil
}

// uploadParts sends buf (already holding the first full part) and the rest
// of r as parts, then completes the upload.
func (s *SignedStore) uploadParts(ctx context.Context, key, uploadID string, r io.Reader, buf []byte) (int64, error) {
	var parts []*agentv1.BackupUploadedPart
	var total int64
	n := len(buf)
	for number := 1; ; number++ {
		if number > maxParts {
			return 0, fmt.Errorf("the backup is larger than %d parts of %d MiB", maxParts, s.partSize>>20)
		}
		resp, err := s.do(ctx, &agentv1.BackupStorageRequest{
			Op: agentv1.BackupStorageOp_BACKUP_STORAGE_OP_UPLOAD_PART, Key: key, UploadId: uploadID, PartNumber: uint32(number),
		}, buf[:n])
		if err != nil {
			return 0, err
		}
		if resp.StatusCode/100 != 2 {
			return 0, statusError(resp, fmt.Sprintf("uploading part %d", number))
		}
		etag := resp.Header.Get("ETag")
		drain(resp)
		if etag == "" {
			return 0, fmt.Errorf("uploading part %d: the bucket answered without an ETag", number)
		}
		parts = append(parts, &agentv1.BackupUploadedPart{PartNumber: uint32(number), Etag: etag})
		total += int64(n)
		n, err = io.ReadFull(r, buf)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
			return 0, err
		}
		// io.ErrUnexpectedEOF: buf[:n] is the last, shorter part.
	}
	if _, err := s.step(ctx, &agentv1.BackupStorageRequest{
		Op: agentv1.BackupStorageOp_BACKUP_STORAGE_OP_COMPLETE_MULTIPART, Key: key, UploadId: uploadID, Parts: parts,
	}); err != nil {
		return 0, fmt.Errorf("finishing the upload: %w", err)
	}
	return total, nil
}

func (s *SignedStore) abort(ctx context.Context, key, uploadID string) {
	_, _ = s.step(ctx, &agentv1.BackupStorageRequest{Op: agentv1.BackupStorageOp_BACKUP_STORAGE_OP_ABORT_MULTIPART, Key: key, UploadId: uploadID})
}

// Get implements Store.
func (s *SignedStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	resp, err := s.do(ctx, &agentv1.BackupStorageRequest{Op: agentv1.BackupStorageOp_BACKUP_STORAGE_OP_GET, Key: key}, nil)
	if err != nil {
		return nil, fmt.Errorf("downloading %s: %w", key, err)
	}
	if resp.StatusCode == http.StatusNotFound {
		drain(resp)
		return nil, fmt.Errorf("%w: %s", ErrObjectNotFound, key)
	}
	if resp.StatusCode/100 != 2 {
		return nil, statusError(resp, "downloading "+key)
	}
	return resp.Body, nil
}

// ErrListUnsupported: a keyless destination cannot be listed from the node.
// The panel applies keep_last itself and sends 0.
var ErrListUnsupported = errors.New("listing a keyless backup destination is the panel's job")

// List implements Store: never possible here (ErrListUnsupported).
func (s *SignedStore) List(context.Context, string) ([]Object, error) {
	return nil, ErrListUnsupported
}

// Delete implements Store. A missing object is not an error.
func (s *SignedStore) Delete(ctx context.Context, key string) error {
	resp, err := s.do(ctx, &agentv1.BackupStorageRequest{Op: agentv1.BackupStorageOp_BACKUP_STORAGE_OP_DELETE, Key: key}, nil)
	if err != nil {
		return fmt.Errorf("deleting %s: %w", key, err)
	}
	if resp.StatusCode/100 != 2 && resp.StatusCode != http.StatusNotFound {
		return statusError(resp, "deleting "+key)
	}
	drain(resp)
	return nil
}

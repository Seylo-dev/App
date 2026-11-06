package conn

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func TestParsePin(t *testing.T) {
	fp := bytes.Repeat([]byte{0xab}, 32)
	for _, in := range []string{
		FormatPin(fp),
		hex.EncodeToString(fp),
		"sha256/" + base64.StdEncoding.EncodeToString(fp),
		base64.RawURLEncoding.EncodeToString(fp),
		" SHA256:" + hex.EncodeToString(fp) + "\n",
	} {
		got, err := ParsePin(in)
		if err != nil || !bytes.Equal(got, fp) {
			t.Errorf("ParsePin(%q) = %x, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "sha256:abcd", "not a pin"} {
		if _, err := ParsePin(bad); err == nil {
			t.Errorf("ParsePin(%q) accepted", bad)
		}
	}
}

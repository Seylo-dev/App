package proxy

import "testing"

func TestRecreateReasonNamesWhatChanged(t *testing.T) {
	base := TraefikConfig{Name: "seylo-traefik", Image: "traefik:v1", Network: "edge", DynamicDir: "/d", DataDir: "/a", HTTPPort: 80, HTTPSPort: 443}
	running := func(c TraefikConfig) ContainerInfo {
		spec := c.Spec()
		return ContainerInfo{Image: spec.Image, Cmd: spec.Cmd}
	}
	withEmail := base
	withEmail.AcmeEmail = "owner@example.com"
	otherEmail := base
	otherEmail.AcmeEmail = "new-owner@example.com"
	newImage := withEmail
	newImage.Image = "traefik:v2"
	otherPort := withEmail
	otherPort.HTTPPort = 8080

	cases := []struct {
		name     string
		existing ContainerInfo
		next     TraefikConfig
		want     string
	}{
		{"owner created", running(base), withEmail, "ACME contact email changed"},
		{"owner's email changed", running(withEmail), otherEmail, "ACME contact email changed"},
		{"agent update with a new image", running(withEmail), newImage, "image changed"},
		{"both", running(base), newImage, "image changed, ACME contact email changed"},
		{"something else", running(withEmail), otherPort, "configuration changed"},
		{"Docker did not say", ContainerInfo{}, withEmail, "configuration changed"},
	}
	for _, c := range cases {
		if got := recreateReason(c.existing, c.next.Spec()); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

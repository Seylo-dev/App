package docker

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestNames(t *testing.T) {
	tests := map[string]string{
		ContainerName("abc", 7, 0): "seylo-abc-7",
		ContainerName("abc", 7, 2): "seylo-abc-7-2",
		ProjectNetwork("p1"):       "seylo-p-p1",
		RouteFile("abc"):           "seylo-abc.yml",
		EdgeNetwork:                "seylo-edge",
		EdgeIPv6Network:            "seylo-edge6",
		CgroupParent:               "seylo.slice",
	}
	for got, want := range tests {
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
}

func TestInstanceLabels(t *testing.T) {
	m := InstanceLabels{ServiceID: "abc", ProjectID: "p1", Kind: "app", Generation: 12, Replica: 1}.Map()
	if !IsManaged(m) {
		t.Fatal("instance labels must mark the container as managed")
	}
	if m[LabelTraefikEnable] != "false" {
		t.Fatal("every container must opt out of Traefik's Docker provider")
	}
	if m[LabelGeneration] != "12" || m[LabelReplica] != "1" || m[LabelService] != "abc" {
		t.Fatalf("labels = %v", m)
	}
	if _, ok := m[LabelProtected]; ok {
		t.Fatal("protected label set on an unprotected service")
	}
	if IsManaged(map[string]string{"com.example": "x"}) {
		t.Fatal("foreign resource reported as managed")
	}
}

func TestNetworkOptionsNameTheEdgeBridge(t *testing.T) {
	if got := NetworkOptions(EdgeNetwork)[BridgeNameOption]; got != EdgeNetwork {
		t.Fatalf("edge network bridge name = %q, want %q (the installer's ufw rule names it)", got, EdgeNetwork)
	}
	if got := NetworkOptions(ProjectNetwork("0123456789abcdef")); got != nil {
		t.Fatalf("a name longer than an interface name got options %v", got)
	}
}

func TestPanelIDHolders(t *testing.T) {
	etc := t.TempDir()
	if got := PanelIDHolders(etc); len(got) != 0 {
		t.Fatalf("no passwd or group file: %v, want none", got)
	}
	passwd := "root:x:0:0:root:/root:/bin/bash\n" +
		"# panel:x:61000:61000::/:/bin/false (a comment)\n" +
		"ubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n" +
		"ops:x:61000:100::/home/ops:/bin/bash\n" +
		"broken line\n"
	group := "root:x:0:\nubuntu:x:1000:\nshared:x:61000:ops\n"
	for name, data := range map[string]string{"passwd": passwd, "group": group} {
		if err := os.WriteFile(filepath.Join(etc, name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got, want := PanelIDHolders(etc), []string{"user ops", "group shared"}; !slices.Equal(got, want) {
		t.Fatalf("PanelIDHolders = %v, want %v", got, want)
	}
	// uid 1000 or a gid of 61000 in passwd is no holder by itself.
	if err := os.WriteFile(filepath.Join(etc, "passwd"), []byte("ubuntu:x:1000:61000::/home/ubuntu:/bin/bash\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, want := PanelIDHolders(etc), []string{"group shared"}; !slices.Equal(got, want) {
		t.Fatalf("PanelIDHolders = %v, want %v", got, want)
	}
}

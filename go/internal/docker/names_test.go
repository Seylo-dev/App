package docker

import "testing"

func TestNames(t *testing.T) {
	tests := map[string]string{
		ContainerName("abc", 7, 0): "seylo-abc-7",
		ContainerName("abc", 7, 2): "seylo-abc-7-2",
		ProjectNetwork("p1"):       "seylo-p-p1",
		RouteFile("abc"):           "seylo-abc.yml",
		EdgeNetwork:                "seylo-edge",
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

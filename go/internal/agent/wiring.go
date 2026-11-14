package agent

import (
	"fmt"
)

// owner is one area's hooks into the composition root. Each owner fills
// its own wire_<area>.go file and nothing else in this package.
type owner struct {
	name string
	// provide builds the owner's components and stores the ones other
	// owners use in Deps (phase 1). It may only read the core block of
	// Deps and fields set by owners earlier in the list.
	provide func(d *Deps) error
	// wire registers RPC handlers, background loops and connection hooks
	// (phase 2). Every Deps field that any owner provides is set by now.
	wire func(reg *Registry, d *Deps) error
}

// owners runs in this order in both phases. Runtime comes first because it
// provides the Docker engine everything else uses.
var owners = []owner{
	{"runtime", provideRuntime, wireRuntime},
	{"dnscache", provideDNSCache, wireDNSCache},
	{"observe", provideObserve, wireObserve},
	{"network", provideNetwork, wireNetwork},
	{"build", provideBuild, wireBuild},
	{"jobs", provideJobs, wireJobs},
	{"node", provideNode, wireNode},
	{"tailnet", provideTailnet, wireTailnet},
}

// Wire runs every owner's provide, then every owner's wire, and returns
// the finished registry. Capabilities are recorded in d.Facts: one is
// advertised only when all of its methods are registered.
func Wire(d *Deps) (*Registry, error) {
	if d.Components == nil {
		d.Components = &Components{}
	}
	if d.Facts == nil {
		d.Facts = NewFacts(d.Events)
	}
	for _, o := range owners {
		if err := o.provide(d); err != nil {
			return nil, fmt.Errorf("providing %s components: %w", o.name, err)
		}
	}
	reg := newRegistry()
	registerCore(reg, d)
	for _, o := range owners {
		if err := o.wire(reg, d); err != nil {
			return nil, fmt.Errorf("wiring %s: %w", o.name, err)
		}
	}
	if err := reg.Err(); err != nil {
		return nil, err
	}
	d.Facts.setCapabilities(reg.Capabilities())
	return reg, nil
}

package geoip

// Report is the visitor country header's state on a node, for the node
// health check (nodecheck's "Visitor country header").
type Report struct {
	// Enabled is NodeSettings.country_header.
	Enabled bool
	// Listen is the server's address ("172.30.0.1:5758"); empty while the
	// edge network is not known.
	Listen string
	// Health is the server's answer, HealthErr why there was none.
	Health    Health
	HealthErr string
	// Asked says the route files ask the server now.
	Asked bool
	// Unreachable is why Traefik's container cannot reach the server (the
	// agent's own check can), usually a host firewall on the edge bridge.
	Unreachable string
	// State is the installed database's record (state.json).
	State State
}

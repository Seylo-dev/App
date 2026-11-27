// Package geoip is the visitor country lookup behind the X-Seylo-Country
// request header (added in 0.2.24, NodeSettings.country_header).
//
// How a request gets the header: every route of a service with the header
// on has a Traefik forwardAuth middleware (proxy.BuildInput.Country) that
// asks the lookup server on the edge network's gateway (DefaultPort) about
// the request. The server answers 200 with the visitor's country in Header
// and nothing else; forwardAuth deletes every header the client sent under
// that name or an alias of it (HeaderAliases) and copies the server's onto
// the request. With the header off a headers middleware only deletes what
// the client sent.
//
// What is here:
//
//   - DB (db.go): a country database (MaxMind DB format) held in memory,
//     Country(ip) the ISO 3166-1 alpha-2 code, Unknown when none.
//   - ClientIP (client.go): which address the lookup uses: the X-Real-Ip
//     Traefik's entry point set from the connection (another node's on the
//     LB entry point, which only nodes reach), and CF-Connecting-IP when
//     that address is one of Cloudflare's.
//   - Server (server.go): the HTTP server `seylo geoip serve` runs, with the
//     database reloaded when its file changes, on the socket systemd hands
//     it (units.go: a socket unit holds the port, so a restart of the
//     server delays requests instead of failing them).
//   - Fetcher (fetch.go): downloads DB-IP's IP to Country Lite (CC BY 4.0,
//     monthly, no account), or MaxMind's GeoLite2 Country when DB-IP fails
//     and a MaxMind account is set, checks it and installs it atomically.
//   - Units (units.go): the socket and service units and their upkeep.
//
// The server runs apart from the agent so a restarting or crashing agent
// never fails requests: forwardAuth answers 500 when its server cannot be
// reached.
package geoip

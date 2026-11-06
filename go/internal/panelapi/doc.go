// Package panelapi is the laptop CLI's client for the panel's op API
// (`seylo login|deploy|logs <service>|env|tunnel`): GET /api/v1/<id> with
// query parameters for queries, POST /api/v1/<id> with JSON for the rest,
// `Authorization: Bearer <api key>`, and the panel's
// {"error": {code, message}} bodies as *APIError.
//
// It is a small hand-written client over the contracts in
// packages/ops/src/ops (openapi.json is generated from the same
// contracts): only the fields the CLI reads are declared, so new fields
// never break it. Services are named "<project>/<service>", a bare name
// when unique, or an id.
//
// Credentials live in ~/.config/seylo/config.json (mode 0600), one profile
// per panel; SEYLO_PANEL_URL + SEYLO_TOKEN override it for CI.
//
// Interfaces used by other packages:
//
//   - Login, Logout, Open and the Client methods, called by package cli.
package panelapi

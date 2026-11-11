//go:build integration

package portgate

// Images of the engines added in 0.2, pinned like the panel's catalog
// (apps/panel/src/modules/databases/engines.ts).
const (
	imageValkey     = "valkey/valkey:9.1.3-alpine"
	imageKeyDB      = "eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac"
	imageDragonfly  = "ghcr.io/dragonflydb/dragonfly:v2.0.2"
	imageClickHouse = "clickhouse/clickhouse-server:26.8.36.3"
	// The newest MongoDB line of the catalog.
	imageMongo90 = "mongo:9.0.4"
)

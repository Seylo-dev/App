package dbengine

import (
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Capability is advertised in NodeFacts.capabilities by agents that handle
// Valkey, KeyDB, Dragonfly and ClickHouse (shells, web UIs, backups and
// TLS on the exposed port). It has no RPC: the panel reads it before it
// places such a database on a node (database.proto).
const Capability = "database.engines.v2"

// Port is the engine's main port inside the container (ClickHouse: the
// native protocol), 0 for an engine this agent does not know.
func Port(e agentv1.DatabaseEngine) uint32 {
	switch e {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		return 5432
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		return 3306
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		return 27017
	case agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:
		return 9000
	}
	if RedisLike(e) {
		return 6379
	}
	return 0
}

// HTTPPort is ClickHouse's HTTP interface (its web UI and HTTP clients);
// 0 for every other engine.
func HTTPPort(e agentv1.DatabaseEngine) uint32 {
	if e == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE {
		return 8123
	}
	return 0
}

// RedisLike reports the engines that speak the Redis protocol with one
// password-protected default user and keep their data as an RDB file in
// the data volume: Redis, Valkey, KeyDB and Dragonfly.
func RedisLike(e agentv1.DatabaseEngine) bool {
	switch e {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS,
		agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY,
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB,
		agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY:
		return true
	}
	return false
}

// RedisCLI is the command-line client in a Redis-like engine's own image:
// valkey-cli and keydb-cli in theirs, redis-cli in Redis's and
// Dragonfly's. "" for other engines.
func RedisCLI(e agentv1.DatabaseEngine) string {
	switch e {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY:
		return "valkey-cli"
	case agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB:
		return "keydb-cli"
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY:
		return "redis-cli"
	}
	return ""
}

// TLSAtGate reports the engines whose exposed port the portgate wraps in
// TLS itself: their protocols carry no TLS upgrade (or the image has no
// certificate set up), so clients speak TLS from the first byte and the
// relay can terminate it. Postgres, MySQL and MariaDB negotiate TLS inside
// their protocol and use their own certificate.
func TLSAtGate(e agentv1.DatabaseEngine) bool {
	return e == agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO || e == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE || RedisLike(e)
}

// SeparateExposedUser reports the engines that get their own login for the
// exposed port (DatabaseExposure.user); Redis-like engines have one user
// and use it over TLS.
func SeparateExposedUser(e agentv1.DatabaseEngine) bool {
	return Port(e) != 0 && !RedisLike(e)
}

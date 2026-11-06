package dbengine

import (
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestEngineFacts(t *testing.T) {
	type want struct {
		port, http uint32
		redis      bool
		cli        string
		gate       bool
		separate   bool
	}
	cases := map[agentv1.DatabaseEngine]want{
		agentv1.DatabaseEngine_DATABASE_ENGINE_UNSPECIFIED: {},
		agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:    {port: 5432, separate: true},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL:       {port: 3306, separate: true},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:     {port: 3306, separate: true},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:       {port: 27017, gate: true, separate: true},
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:       {port: 6379, redis: true, cli: "redis-cli", gate: true},
		agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY:      {port: 6379, redis: true, cli: "valkey-cli", gate: true},
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB:       {port: 6379, redis: true, cli: "keydb-cli", gate: true},
		agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY:   {port: 6379, redis: true, cli: "redis-cli", gate: true},
		agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:  {port: 9000, http: 8123, gate: true, separate: true},
		agentv1.DatabaseEngine(99):                         {},
	}
	for e, w := range cases {
		got := want{port: Port(e), http: HTTPPort(e), redis: RedisLike(e), cli: RedisCLI(e), gate: TLSAtGate(e), separate: SeparateExposedUser(e)}
		if got != w {
			t.Errorf("%v: got %+v, want %+v", e, got, w)
		}
	}
}

// Every engine the protocol names is known here, so a new enum value
// cannot slip through with port 0.
func TestEveryEngineHasAPort(t *testing.T) {
	for n := range agentv1.DatabaseEngine_name {
		e := agentv1.DatabaseEngine(n)
		if e == agentv1.DatabaseEngine_DATABASE_ENGINE_UNSPECIFIED {
			continue
		}
		if Port(e) == 0 {
			t.Errorf("%v has no port", e)
		}
	}
}

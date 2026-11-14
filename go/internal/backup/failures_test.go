package backup

import (
	"strings"
	"testing"
	"time"
)

func TestConnectionLostHint(t *testing.T) {
	cases := []struct {
		line string
		dump bool
		want string // in the hint; "" means no hint
	}{
		// The owner's report (MariaDB 11.4 with TLS).
		{"mariadb-dump: Error 2026: TLS/SSL error: unexpected eof while reading when dumping table `PlayerStage` at row: 812345", true, `"Aborted connection"`},
		{"mariadb-dump: Error 2013: Lost connection to server during query when dumping table `PlayerStage` at row: 98934", true, "middle of the dump"},
		{"mysqldump: Got error: 2013: Lost connection to MySQL server during query when using LOCK TABLES", true, "slow upload to the bucket"},
		{"mysqldump: Couldn't execute 'SHOW TRIGGERS LIKE 't'': Lost connection to MySQL server during query (2013)", true, "middle of the dump"},
		// The same with TLS: the eof comes before the code.
		{"mysqldump: Couldn't execute 'SHOW TRIGGERS LIKE 't'': SSL connection error: unexpected eof while reading (2026)", true, "middle of the dump"},
		{"mysqldump: Couldn't execute 'SELECT 1': TLS/SSL error: Connection reset by peer (2026)", true, "middle of the dump"},
		{"ERROR 2006 (HY000) at line 69835: Server has gone away", false, "slow download from the bucket"},
		{"ERROR 4031 (HY000) at line 62: The client was disconnected by the server because of inactivity. See wait_timeout and interactive_timeout for configuring this behavior.", false, "middle of the restore"},
		{"ERROR 2026 (HY000) at line 5: TLS/SSL error: unexpected eof while reading", false, "middle of the restore"},
		{"I/O Error reading RDB payload from socket", true, `"Disconnecting timedout replica"`},
		{"psql:<stdin>:13772: error: connection to server was lost", false, `"terminating connection"`},
		{"pg_dump: error: Dumping the contents of table \"t\" failed: PQgetResult() failed. pg_dump: detail: Error message from server: server closed the connection unexpectedly", true, "middle of the dump"},
		// Not a lost connection.
		{"mariadb-dump: Got error: 2026: TLS/SSL error: self-signed certificate in certificate chain when trying to connect", true, ""},
		{"mysqldump: Got error: 2026: SSL connection error: error:0A000086:SSL routines::certificate verify failed (2026) when trying to connect", true, ""},
		{"ERROR 1045 (28000): Access denied for user 'root'@'10.0.0.5' (using password: YES)", false, ""},
		{"mysqldump: Got error: 2005: Unknown MySQL server host 'db' (-2) when trying to connect", true, ""},
		{noOutput, true, ""},
	}
	for _, c := range cases {
		got := connectionLostHint(c.line, c.dump, nil)
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("%q: hint %q, want one with %q", c.line, got, c.want)
		}
		if got != "" && (strings.Contains(got, "..") || strings.Contains(got, "\u2014")) {
			t.Errorf("%q: hint %q", c.line, got)
		}
	}
	// The whole message keeps the tool's line first; a line that ends with
	// a full stop gets no second one.
	line := "mariadb-dump: Error 2026: TLS/SSL error: unexpected eof while reading when dumping table `PlayerStage` at row: 812345"
	want := line + ". The database closed the connection in the middle of the dump. Usually it restarted or ran out of memory: " +
		`look in its Logs for a restart or "Aborted connection". Before Seylo 0.2.17 a slow upload to the bucket caused this too.`
	if got := line + connectionLostHint(line, true, nil); got != want {
		t.Fatalf("message:\n%s\nwant:\n%s", got, want)
	}
	if got := connectionLostHint("ERROR 4031 (HY000) at line 62: ... this behavior.", false, nil); !strings.HasPrefix(got, " The database closed") {
		t.Fatalf("hint after a full stop = %q", got)
	}
}

// TestConnectionLostHintAfterAHold: a dump the database dropped right
// after it waited for the upload (the spool had no room) says so instead of
// blaming a restart; the restores, Postgres (it never drops a slow reader)
// and other failures keep their message.
func TestConnectionLostHintAfterAHold(t *testing.T) {
	floor := &spoolHold{why: holdFloor, held: 16 << 20, dur: 75 * time.Second}
	ceiling := &spoolHold{why: holdCeiling, held: 4<<30 + 16<<20, dur: 62*time.Second + 400*time.Millisecond}
	line := "mariadb-dump: Error 2026: TLS/SSL error: unexpected eof while reading when dumping table `PlayerStage` at row: 812345"
	want := line + ". The database closed the connection after the dump waited 1m15s for the upload: the upload fell behind the dump by more than 16.8 MB " +
		"and the node has no room to hold it (backups leave 15% of its disk and 10 GiB free). Free space on the node, use a bucket it reaches faster or raise the database's net_write_timeout and wait_timeout."
	if got := line + connectionLostHint(line, true, floor); got != want {
		t.Fatalf("message:\n%s\nwant:\n%s", got, want)
	}
	want = ". The database closed the connection after the dump waited 1m2s for the upload: the upload fell behind the dump by more than 4.3 GB, " +
		"the most one backup holds on the node. Use a bucket the node reaches faster or raise the database's repl-timeout."
	if got := connectionLostHint("I/O Error reading RDB payload from socket", true, ceiling); got != want {
		t.Fatalf("redis message:\n%s\nwant:\n%s", got, want)
	}
	// mysqldump says nothing when wait_timeout closed its session.
	want = ". The dump stopped without a message right after it waited 1m15s for the upload: the upload fell behind the dump by more than 16.8 MB " +
		"and the node has no room to hold it (backups leave 15% of its disk and 10 GiB free), so the database most likely closed its connection meanwhile. " +
		"Free space on the node, use a bucket it reaches faster or raise the database's wait_timeout and net_write_timeout."
	if got := connectionLostHint(noOutput, true, floor); got != want {
		t.Fatalf("silent dump:\n%s\nwant:\n%s", got, want)
	}
	for _, c := range []struct {
		line string
		dump bool
		want string
	}{
		{"ERROR 2013 (HY000) at line 5: Lost connection to server during query", false, "middle of the restore"},
		{noOutput, false, ""},
		{"pg_dump: error: Dumping the contents of table \"t\" failed: PQgetResult() failed. pg_dump: detail: Error message from server: server closed the connection unexpectedly", true, "middle of the dump"},
		{"ERROR 1045 (28000): Access denied for user 'root'@'10.0.0.5' (using password: YES)", true, ""},
	} {
		got := connectionLostHint(c.line, c.dump, floor)
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("%q after a hold: hint %q, want one with %q", c.line, got, c.want)
		}
	}
}

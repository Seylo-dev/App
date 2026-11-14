package backup

import (
	"strings"
	"testing"
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
		{"ERROR 2006 (HY000) at line 69835: Server has gone away", false, "slow download from the bucket"},
		{"ERROR 4031 (HY000) at line 62: The client was disconnected by the server because of inactivity. See wait_timeout and interactive_timeout for configuring this behavior.", false, "middle of the restore"},
		{"ERROR 2026 (HY000) at line 5: TLS/SSL error: unexpected eof while reading", false, "middle of the restore"},
		{"I/O Error reading RDB payload from socket", true, `"Disconnecting timedout replica"`},
		{"psql:<stdin>:13772: error: connection to server was lost", false, `"terminating connection"`},
		{"pg_dump: error: Dumping the contents of table \"t\" failed: PQgetResult() failed. pg_dump: detail: Error message from server: server closed the connection unexpectedly", true, "middle of the dump"},
		// Not a lost connection.
		{"mariadb-dump: Got error: 2026: TLS/SSL error: self-signed certificate in certificate chain when trying to connect", true, ""},
		{"ERROR 1045 (28000): Access denied for user 'root'@'10.0.0.5' (using password: YES)", false, ""},
		{"mysqldump: Got error: 2005: Unknown MySQL server host 'db' (-2) when trying to connect", true, ""},
		{"no output", true, ""},
	}
	for _, c := range cases {
		got := connectionLostHint(c.line, c.dump)
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
	if got := line + connectionLostHint(line, true); got != want {
		t.Fatalf("message:\n%s\nwant:\n%s", got, want)
	}
	if got := connectionLostHint("ERROR 4031 (HY000) at line 62: ... this behavior.", false); !strings.HasPrefix(got, " The database closed") {
		t.Fatalf("hint after a full stop = %q", got)
	}
}

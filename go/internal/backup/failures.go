package backup

import (
	"regexp"
	"strings"
)

// connectionLost lists the last lines of dump and restore tools whose
// server closed the connection under them, with what the server's own log
// says then.
var connectionLost = []struct {
	re   *regexp.Regexp
	logs string
}{
	// MySQL and MariaDB clients: 2013 lost connection during a query, 2006
	// server gone away (it closed an idle connection), 4031 disconnected
	// for inactivity (MySQL 8.0.24+), and 2026 when TLS saw the connection
	// end (unexpected eof). The tools print "Error 2013: ..." (dumps),
	// "Got error: 2013: ...", "ERROR 2013 (HY000) at line 5: ..." (the
	// clients) or "... (2013)".
	{regexp.MustCompile(`(?i)\berror:? (2006|2013|4031)\b|\((2006|2013|4031)\)|\b(error:? 2026\b|\(2026\)).*\b(eof|reset|broken pipe)\b`),
		`a restart or "Aborted connection"`},
	// redis-cli, valkey-cli and keydb-cli --rdb: the server dropped the
	// replica connection the RDB comes through.
	{regexp.MustCompile(`(?i)error reading (the )?RDB payload|while SYNCing`),
		`a restart or "Disconnecting timedout replica"`},
	// pg_dump, pg_restore and psql.
	{regexp.MustCompile(`(?i)server closed the connection unexpectedly|connection to server was lost|terminating connection due to`),
		`a restart or "terminating connection"`},
}

// connectionLostHint says what a failed dump's or restore's last line
// means when the database closed the connection in the middle of it, and
// what usually causes that; "" for any other line.
func connectionLostHint(line string, dump bool) string {
	for _, c := range connectionLost {
		if !c.re.MatchString(line) {
			continue
		}
		what, transfer := "restore", "download from"
		if dump {
			what, transfer = "dump", "upload to"
		}
		sep := ". "
		if strings.HasSuffix(line, ".") {
			sep = " "
		}
		return sep + "The database closed the connection in the middle of the " + what +
			". Usually it restarted or ran out of memory: look in its Logs for " + c.logs +
			". Before Seylo 0.2.17 a slow " + transfer + " the bucket caused this too."
	}
	return ""
}

package backup

import (
	"regexp"
	"strings"
	"time"
)

// connectionLost lists the last lines of dump and restore tools whose
// server closed the connection under them, with what the server's own log
// says then and the setting it drops a dump that stops reading by.
var connectionLost = []struct {
	re      *regexp.Regexp
	logs    string
	timeout string
	// also: one more cause, said after the usual ones.
	also string
}{
	// MySQL and MariaDB clients: 2013 lost connection during a query, 2006
	// server gone away (it closed an idle connection), 4031 disconnected
	// for inactivity (MySQL 8.0.24+). The tools print "Error 2013: ..."
	// (dumps), "Got error: 2013: ...", "ERROR 2013 (HY000) at line 5: ..."
	// (the clients) or "...: <message> (2013)" (mysqldump's "Couldn't
	// execute").
	{re: regexp.MustCompile(`(?i)\berror:? (2006|2013|4031)\b|\((2006|2013|4031)\)`),
		logs: `a restart or "Aborted connection"`, timeout: "net_write_timeout and wait_timeout"},
	// 2026 when TLS saw the connection end (unexpected eof), where the eof
	// comes before the code in "Couldn't execute". The jobs only use TLS
	// when the server refuses plain connections (mysqlPrelude), and then
	// MariaDB's thread pool can drop them too.
	{re: regexp.MustCompile(`(?i)\berror:? 2026\b.*\b(eof|reset|broken pipe)\b|\b(eof|reset|broken pipe)\b.*\(2026\)`),
		logs: `a restart or "Aborted connection"`, timeout: "net_write_timeout and wait_timeout",
		also: "Over TLS, MariaDB with thread_handling=pool-of-threads also drops connections right after many clients left at once."},
	// redis-cli, valkey-cli and keydb-cli --rdb: the server dropped the
	// replica connection the RDB comes through.
	{re: regexp.MustCompile(`(?i)error reading (the )?RDB payload|while SYNCing`),
		logs: `a restart or "Disconnecting timedout replica"`, timeout: "repl-timeout"},
	// pg_dump, pg_restore and psql. Postgres never drops a dump that stops
	// reading.
	{re: regexp.MustCompile(`(?i)server closed the connection unexpectedly|connection to server was lost|terminating connection due to`),
		logs: `a restart or "terminating connection"`},
}

// noOutput stands for the last line of a tool that wrote nothing to stderr.
const noOutput = "no output"

// connectionLostHint says what a failed dump's or restore's last line
// means when the database closed the connection in the middle of it, and
// what usually causes that; "" for any other line. hold is the dump's last
// long wait for the upload (spool.recentHold), nil when there was none:
// with one, the database most likely dropped the dump while it waited,
// also when the dump died without a word (mysqldump 8.0 and 8.4 exit 2
// silently once wait_timeout closed their session).
func connectionLostHint(line string, dump bool, hold *spoolHold) string {
	if dump && hold != nil && line == noOutput {
		return ". The dump stopped without a message right after it waited " + hold.dur.Round(time.Second).String() +
			" for the upload: " + hold.what() + ", so the database most likely closed its connection meanwhile. " +
			holdFix(hold, "wait_timeout and net_write_timeout")
	}
	for _, c := range connectionLost {
		if !c.re.MatchString(line) {
			continue
		}
		sep := ". "
		if strings.HasSuffix(line, ".") {
			sep = " "
		}
		if dump && hold != nil && c.timeout != "" {
			return sep + "The database closed the connection after the dump waited " + hold.dur.Round(time.Second).String() +
				" for the upload: " + hold.what() + ". " + holdFix(hold, c.timeout)
		}
		what, transfer := "restore", "download from"
		if dump {
			what, transfer = "dump", "upload to"
		}
		also := ""
		if c.also != "" {
			also = " " + c.also
		}
		return sep + "The database closed the connection in the middle of the " + what +
			". Usually it restarted or ran out of memory: look in its Logs for " + c.logs + "." + also +
			" Before Seylo 0.2.17 a slow " + transfer + " the bucket caused this too."
	}
	return ""
}

// lostConnection says whether a failed dump's last line means the database
// closed the connection for a reason of its own (a restart, a TLS error, a
// dropped network), which a second try a little later usually gets past.
// A connection closed while the dump waited for the upload is not one:
// the same upload would wait again.
func lostConnection(line string, hold *spoolHold) bool {
	for _, c := range connectionLost {
		if c.re.MatchString(line) {
			return hold == nil || c.timeout == ""
		}
	}
	return false
}

// errLostConnection marks a dump the database closed under it (see
// lostConnection); line is the dump's last line.
type errLostConnection struct {
	err  error
	line string
}

func (e *errLostConnection) Error() string { return e.err.Error() }
func (e *errLostConnection) Unwrap() error { return e.err }

// holdFix says what avoids a dump dropped while it waited for the upload;
// timeout names the database's settings.
func holdFix(h *spoolHold, timeout string) string {
	if h.why == holdFloor {
		return "Free space on the node, use a bucket it reaches faster or raise the database's " + timeout + "."
	}
	return "Use a bucket the node reaches faster or raise the database's " + timeout + "."
}

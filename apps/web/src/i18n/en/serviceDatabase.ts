// English strings: serviceDatabase. See ../t.ts for keys, placeholders and plurals.
// The Connection tab of databases and the database shell.

export default {
  internal: "Internal connection",
  internalFor: "for services on {node} in this project",
  url: "Connection URL",
  httpUrl: "HTTP URL",
  httpPort: "HTTP port",
  pgvectorBefore: "pgvector is installed. Turn it on in a database with",
  pgvectorAfter: "(once per database).",
  host: "Host",
  port: "Port",
  database: "Database",
  user: "User",
  password: "Password",
  exposed: "Exposed connection",
  exposedUrl: "Exposed connection URL",
  exposedToggle: "Exposed",
  sslRequired: "SSL required",
  notExposed:
    "Off. Only services of this project on the same node can connect. Turn it on to reach the database from other nodes or your laptop, with TLS.",
  opening: "Opening the port…",
  waitingForNode:
    "Closed until {node} updates to 0.2.9: its agent cannot keep this port TLS-only yet. Exposure stays on, and the port opens by itself after the update.",
  sameUserBefore: "The same user",
  sameUserAfter: "and password as inside, here only over TLS. The internal URL is unchanged.",
  sameUserAfterPlain: "and password as inside, here with or without TLS. The internal URL is unchanged.",
  allowedFrom: "Allowed from:",
  anywhere: "anywhere",
  /** Connections without TLS on the exposed port (databases.setExposure allowPlain). */
  plain: {
    label: "Allow connections without TLS",
    chip: "TLS optional",
    off: "Off: clients that do not ask for TLS are refused.",
    on: "Clients without TLS are accepted too. The URL above still asks for TLS, which keeps working.",
    mysqlKey:
      "MySQL clients without TLS need the server's public key to send the password: --get-server-public-key, or allowPublicKeyRetrieval=true in JDBC.",
    needsAgent: "Needs the node's agent {version}: update {node} to turn it on.",
    waitingForAgent: "On, but this needs the node's agent {version}: the port stays TLS only until {node} is updated.",
    confirm: {
      title: "Allow connections without TLS?",
      body: "Clients that do not ask for TLS can then sign in to {name}. Their queries, the data they get back and, with some sign-in methods, the password travel unencrypted: anyone on the network path can read them.",
      passwordInClear: "This engine's clients send the password itself unencrypted.",
      openToEveryone:
        "With no allowed IPs, or ones that cover every address such as 0.0.0.0/0, this port is open to every IP address: anyone who has or guesses the password can sign in without TLS from anywhere, and everything sent can be read on the way. Limit it to your IPs if you can.",
      limited: "The allowed IPs still apply: only {cidrs} can connect.",
      prefer: "TLS clients keep working as before. Prefer TLS, or a timed expose for a one-off connection.",
      button: "Allow without TLS",
    },
    /** Saving an allow list that lets every IP in (empty, or a catch-all such as 0.0.0.0/0) while connections without TLS are allowed. */
    openConfirm: {
      title: "Open this port to every IP?",
      body: "Connections without TLS are allowed on {name}, and this allow list lets every IP address in, so clients that do not ask for TLS can sign in from anywhere.",
      button: "Open to every IP",
    },
  },
  limit: "Limit to IPs",
  certificate: "Certificate",
  certIssuer: "via {issuer}",
  certExpires: "valid until {date}",
  cert: { none: "none", selfSigned: "self-signed", pending: "being issued", valid: "valid", failed: "failed" },
  selfSigned: {
    title: "Self-signed certificate",
    body: "Connections are encrypted, but clients that check certificates refuse this one.",
    reason: {
      noHostname: "No TLS host name is set, so the node uses a certificate of its own.",
      acmeMissing: "The node has no Let's Encrypt certificate for {host} yet.",
      engine: "MariaDB always serves the certificate it makes itself, with or without a TLS host name.",
    },
    lastError: "Last attempt: {error}",
    getTrusted:
      "For a trusted one, set a TLS host name under Port and access, give it an A record to the node set to DNS only (not proxied), and let port 80 reach the node.",
    fixAcme:
      "Let's Encrypt checks the name over port 80: {host} needs an A record to the node set to DNS only (not proxied), and port 80 has to reach the node.",
    meanwhile: {
      postgres:
        "Until then, node-postgres connects with sslmode=no-verify (or uselibpqcompat=true&sslmode=require); psql and other libpq clients are fine with sslmode=require.",
      mysql:
        "Until then, ssl-mode=REQUIRED connects: it encrypts without checking the certificate. VERIFY_CA and VERIFY_IDENTITY need the certificate.",
      mariadb:
        "Clients connect with ssl-mode=REQUIRED (mariadb --ssl --skip-ssl-verify-server-cert), which encrypts without checking the certificate.",
      mongo: "Until then, add tlsAllowInvalidCertificates=true to the URL.",
      mongoInUrl: "The exposed URL already accepts it (tlsAllowInvalidCertificates=true).",
      clickhouse: "Until then, add skip_verify=true to the URL.",
      clickhouseInUrl: "The exposed URL already accepts it (skip_verify=true).",
      redis: "Until then, tell the client to skip the check (redis-cli --insecure) or give it the certificate (--cacert).",
    },
    download: "Download certificate",
    downloadHint: "or trust this file in the client (sslrootcert, ssl-ca, tlsCAFile) and connect by {host}.",
    // Without a TLS host name the certificate names no host, so only a client that skips the name check connects with the file.
    downloadHintNoHost: {
      postgres:
        "or trust this file with sslmode=verify-ca and sslrootcert (node-postgres also needs uselibpqcompat=true). It names no host until a TLS host name is set, so verify-full refuses it.",
      mysql:
        "or trust this file with ssl-mode=VERIFY_CA and ssl-ca. It names no host until a TLS host name is set, so VERIFY_IDENTITY refuses it.",
      mongo:
        "or trust this file with tlsCAFile and tlsAllowInvalidHostnames=true. It names no host until a TLS host name is set, so tlsCAFile alone refuses it.",
      other:
        "or trust this file in a client that does not check the host name. It names no host until a TLS host name is set, so a client that checks it refuses it.",
    },
  },
  /** The timed expose card: the database's port to one IP for a while (timed-expose-card.tsx). */
  timed: {
    title: "Timed expose",
    open: "Open",
    closed: "Closed",
    body: "Opens {name} on {node} to your IP for a while, for a client on your laptop. The node closes it on time, even when the panel is down. It adds no TLS: only the database's own.",
    duration: "For",
    port: "Port",
    portNative: "{port}, native protocol",
    portHttp: "{port}, HTTP (JDBC, DBeaver)",
    allowedFrom: "Only from",
    allowedHint: "IPs or CIDRs. Empty uses your own address.",
    yourIp: "Your IP",
    openFromMyIp: "Open for {duration} from my IP",
    openFor: "Open for {duration}",
    openAnother: "Open another",
    opening: "Opening the port…",
    onlyFrom: "only from {cidrs}",
    url: "Connection URL",
    urlNoPassword: "Connection URL (without the password)",
    command: "Command",
    asksPassword: "The command asks for the password, the same as inside.",
    asksPasswordHidden: "The command asks for the password. You need access to the database's credentials to see it.",
    tls: {
      postgres: "Encrypted by PostgreSQL itself (TLS is on while it is exposed): the URL and command ask for it with sslmode=require.",
      mysql: "Encrypted by MySQL itself, with its own certificate: the URL and command ask for it (ssl-mode=REQUIRED).",
      mariadb: "Encrypted by MariaDB itself, with its own certificate: the command asks for it with --ssl.",
    },
    plain:
      "Not encrypted: {engine} has no TLS on this port, so the connection crosses the network in the clear. Only {cidrs} can connect, and the port closes on time. For TLS, use the exposed connection.",
    closesIn: "Closes in",
  },
  exposureTitle: "Exposure settings",
  exposureBody: "Who may connect, and which certificate the database presents.",
  allowedIps: "Allowed IPs",
  allowlistRequired:
    "This engine gets no security fixes, so it can only be exposed to the IPs or CIDRs you list here. Prefer Valkey for anything public.",
  tlsHostname: "TLS host name",
  tlsHostnameHint: "A name pointing at the node gets a Let's Encrypt certificate. Empty uses a self-signed one.",
  publicPort: "Port",
  publicPortHint: "Empty keeps the current one or picks a free port.",
  publicPortNewHint: "1024 to 65535. Leave it empty and the node picks a free one.",
  publicPortAuto: "Any free port",
  exposeTitle: "Expose {name}",
  exposeBody:
    "Exposing only opens a port on {node} to the database, with TLS: clients sign in with its own user and password. Choose the port, then who may connect.",
  exposeButton: "Expose",
  portAndAccess: "Port and access",
  tools: "Tools",
  open: "Open",
  webUiHint: "Starts when you open it, sleeps after {minutes} min idle",
  webUiRunning: "Running",
  webUiSleeping: "Sleeping",
  webUiActive: "Running, last used {when}. Sleeps after {minutes} min idle",
  shellHint: "A shell already logged in to {database}",
  shellHintRedis: "A shell already logged in",
  shell: "Database shell",
  shellTitle: "{client} · {name}",
  shellSubtitle: "Already signed in. What you type runs against the database.",
  shellConnected: "Connected with {client} to {name}",
  scheduleBackups: "Schedule backups",
  /** The link next to the user and the password, to the Users tab. */
  change: "Change",
  changeUser: "Change the user",
  changePassword: "Change the password",
} as const;

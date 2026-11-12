// Domains route HTTP traffic to a service: automatic domains from a node's
// wildcard A record, custom domains with a DNS check, paths, HTTPS and
// per-domain middlewares (basic auth, IP allowlist, rate limit, redirects).
// Every op that takes a domainId also takes its serviceId, so the scoped
// permission check runs on the service; the handler checks they match.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

/** Lower-case host name, no scheme, no port. Wildcards are not allowed on services. */
export const Hostname = Type.String({
  minLength: 3,
  maxLength: 253,
  pattern: "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,62}$",
  description: "Lower-case host name without scheme or port, for example shop.example.com.",
});

/** Path prefix starting with "/"; "/" means the whole host. */
export const PathPrefix = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$",
  description: 'Only requests under this path match. "/" is the whole host.',
});

export const ContainerPort = Type.Integer({ minimum: 1, maximum: 65535, description: "Port the container listens on." });

/**
 * IPv4 or IPv6 address or CIDR, for example 198.51.100.24 or 10.0.0.0/8.
 * The pattern only rejects obvious garbage; handlers parse it properly.
 */
export const Cidr = Type.String({ minLength: 2, maxLength: 64, pattern: "^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$" });

/** acme: Let's Encrypt (default). custom: an uploaded certificate. off: plain HTTP only. */
export const HttpsMode = Type.Union([Type.Literal("acme"), Type.Literal("custom"), Type.Literal("off")]);

/**
 * ok: the record points at the service's node. missing: no record yet.
 * wrongTarget: the record points somewhere else. proxied: only Cloudflare
 * proxy addresses answer, which works once the origin is reachable but hides
 * the target from the check (the origin check, OriginStatus, tells whether it
 * reaches the node). unknown: never checked or the lookup failed.
 */
export const DnsStatus = Type.Union([
  Type.Literal("unknown"),
  Type.Literal("ok"),
  Type.Literal("missing"),
  Type.Literal("wrongTarget"),
  Type.Literal("proxied"),
]);

/**
 * Whether a custom domain whose DNS is ok or proxied reaches the service's
 * node, from the panel's origin check: it fetches
 * http://<host>/.well-known/<slug>-origin/<challenge> and the node's agent
 * answers with a proof signed by its key. node: one of the service's nodes
 * answered. elsewhere: something else answered, so behind Cloudflare's
 * proxy the record there points at another server (Let's Encrypt cannot
 * reach the node either). unknown: no answer (timeout, network error, a
 * 5xx such as Cloudflare's own errors), or not every node of the service
 * runs an agent that answers the check yet.
 */
export const OriginStatus = Type.Union([Type.Literal("node"), Type.Literal("elsewhere"), Type.Literal("unknown")]);

/**
 * Why the last origin check of a domain behind Cloudflare's proxy did not
 * reach the node, from Cloudflare's own answer (a response with Cloudflare's
 * cf-ray or server header). cloudflareCertificate: 525 or 526, SSL/TLS Full
 * (strict) refuses the node's temporary certificate (Traefik's default one,
 * served until Let's Encrypt issues the domain's). cloudflareUnreachable:
 * 521 or 522, Cloudflare cannot connect to the node on port 443 or 80.
 * cloudflareChallenge: Cloudflare's security answered in the node's place
 * (a challenge page, cf-mitigated, or a 403 or 429 from Cloudflare: Bot
 * Fight Mode, Under Attack mode, a WAF or rate limiting rule), which stops
 * Let's Encrypt's request the same way; the origin is unknown, never
 * elsewhere. notFound: 404, the server Cloudflare reached has nothing for
 * the check (the record there points at another server, or the node has no
 * route for the domain yet). Absent for every other answer.
 */
export const OriginReason = Type.Union([
  Type.Literal("cloudflareCertificate"),
  Type.Literal("cloudflareUnreachable"),
  Type.Literal("cloudflareChallenge"),
  Type.Literal("notFound"),
]);

/**
 * Why the service's nodes have no route for a domain, so requests to it do
 * not reach the service and its certificate is not asked for.
 * notDeployed: the service has no deployment to run yet (its first build
 * is queued, building or failed, or its first rollout failed); nothing of
 * it goes to its nodes, routes included, until a deployment goes live.
 * stackParent: the service is a compose stack, which runs no container of
 * its own; the domain belongs on the stack member that serves it.
 * cronService: a cron service runs on its schedule and serves no requests.
 * routeWriteFailed: a node of the service could not write the service's
 * route file (nodes on 0.2.12 report it): it still serves the routes of
 * the file it wrote last, which do not have this domain.
 */
export const NoRouteReason = Type.Union([
  Type.Literal("notDeployed"),
  Type.Literal("stackParent"),
  Type.Literal("cronService"),
  Type.Literal("routeWriteFailed"),
]);

export const NoRoute = Type.Object({
  reason: NoRouteReason,
  /** notDeployed: the service's deployment that is queued or building now, if one is. */
  deploymentId: Type.Optional(Id),
  /** routeWriteFailed: the node that could not write the route file. */
  nodeId: Type.Optional(Id),
  nodeName: Type.Optional(Type.String()),
  /** routeWriteFailed: what the node's agent said, one line. */
  error: Type.Optional(Type.String()),
});

export const CertificateStatus = Type.Union([Type.Literal("none"), Type.Literal("pending"), Type.Literal("valid"), Type.Literal("failed")]);

export const DomainRedirect = Type.Object({
  /** RE2 regular expression matched against the full request URL. */
  from: Type.String({ minLength: 1, maxLength: 500 }),
  /** Replacement; may use $1-style groups. */
  to: Type.String({ minLength: 1, maxLength: 1000 }),
  /** 308 when true, 307 otherwise. */
  permanent: Type.Boolean(),
});

export const DomainRateLimit = Type.Object({
  /** Average requests allowed per period, per source IP. */
  average: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  burst: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  periodSeconds: Type.Integer({ minimum: 1, maximum: 3600, default: 1 }),
});

/** Middlewares as shown; basic auth passwords are hashed and never returned. */
export const DomainMiddlewares = Type.Object({
  basicAuth: Type.Union([Type.Object({ usernames: Type.Array(Type.String()) }), Type.Null()]),
  ipAllowList: Type.Array(Cidr),
  rateLimit: Type.Union([DomainRateLimit, Type.Null()]),
  redirects: Type.Array(DomainRedirect),
});

/** A domain that sends every request to another URL instead of the service. */
export const DomainForward = Type.Object({
  url: Type.String({ minLength: 8, maxLength: 1000, pattern: "^https?://" }),
  /** 308 (true) or 307 (false). */
  permanent: Type.Boolean(),
  /** Keep the request path and query on the target URL. */
  keepPath: Type.Boolean(),
});

export const Domain = Type.Object({
  id: Id,
  serviceId: Id,
  host: Hostname,
  pathPrefix: PathPrefix,
  stripPrefix: Type.Boolean(),
  targetPort: ContainerPort,
  https: HttpsMode,
  redirectToHttps: Type.Boolean(),
  /** Generated from a node's wildcard domain. */
  auto: Type.Boolean(),
  /** The domain other addresses (IP:port, redirects, ${{svc.URL}}) point to. One per service. */
  primary: Type.Boolean(),
  /** Set when this domain only redirects (for example www to the apex). */
  forward: Type.Union([DomainForward, Type.Null()]),
  middlewares: DomainMiddlewares,
  dnsStatus: DnsStatus,
  dnsCheckedAt: Type.Union([Timestamp, Type.Null()]),
  /**
   * What the domain's A and AAAA records point at: the public IPv4, then
   * IPv6, of the node(s) serving the service (their public address when it
   * is an IP). Behind Cloudflare's proxy, the origin to set there. Set by
   * domains.list.
   */
  pointsTo: Type.Optional(Type.Array(Type.String())),
  /**
   * The last origin check of a custom domain (not automatic, not
   * redirect-only) while its DNS is ok or proxied; absent before the first
   * check and while DNS is in another state. domains.checkDns runs it, and
   * so does the panel a few seconds after domains.add.
   */
  origin: Type.Optional(OriginStatus),
  /** When origin was checked. */
  originCheckedAt: Type.Optional(Timestamp),
  /**
   * Why that check did not reach the node, when Cloudflare said (see
   * OriginReason); only with origin unknown or elsewhere. The panel keeps
   * it in memory: after a restart it is absent until the next check.
   */
  originReason: Type.Optional(OriginReason),
  /**
   * Set when the service's nodes have no route for the domain and the
   * panel knows why (see NoRouteReason). While notDeployed, stackParent or
   * cronService holds, the panel runs no origin check for the domain and
   * does not re-check it while its certificate waits for DNS; when a
   * deployment of the service goes live, the waiting domains are checked
   * at once. Set by domains.list and domains.add.
   */
  noRoute: Type.Optional(NoRoute),
  certificate: Type.Object({
    status: CertificateStatus,
    expiresAt: Type.Union([Timestamp, Type.Null()]),
    /** "Let's Encrypt", "Cloudflare" (seen through the proxy) or the custom certificate's issuer. */
    issuer: Type.Union([Type.String(), Type.Null()]),
    /** Why the last issue or renewal failed (status "failed"), as the node reported it. */
    error: Type.Union([Type.String(), Type.Null()]),
    /**
     * Set (true) while Let's Encrypt waits for DNS: the panel has not seen
     * the custom domain reach a node of the service yet (DNS missing or
     * pointing elsewhere, or behind Cloudflare's proxy without the origin
     * check reaching the node), so the node asks for no certificate (it
     * serves the domain over plain HTTP without the redirect, and over
     * HTTPS only with Traefik's default certificate), and failed
     * validations do not use up Let's Encrypt's limits. A DNS lookup that
     * fails leaves a waiting domain waiting. The first check that proves it (domains.checkDns)
     * starts the certificate. Never set for automatic domains, HTTPS modes
     * custom and off, or a domain that has had a certificate.
     */
    waitingForDns: Type.Optional(Type.Boolean()),
  }),
  /** First time the route served with a valid certificate. */
  liveAt: Type.Union([Timestamp, Type.Null()]),
  /** Full URL, for example https://shop.example.com/admin. */
  url: Type.String(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const DnsRecord = Type.Object({
  type: Type.Union([Type.Literal("A"), Type.Literal("AAAA"), Type.Literal("CNAME")]),
  /** Record name relative to the zone ("admin", "@" for the apex) as typed in a DNS panel. */
  name: Type.String(),
  value: Type.String(),
});

export const DnsCheck = Type.Object({
  domainId: Id,
  host: Hostname,
  status: DnsStatus,
  /** Plain sentence for the UI, for example "No A record for admin.example.com yet". */
  message: Type.String(),
  /** Records to create; one A (and AAAA when the node has IPv6) pointing at the node. */
  expected: Type.Array(DnsRecord),
  /** What public resolvers answered. */
  found: Type.Array(DnsRecord),
  /** Registrable zone the record belongs in, for example example.com. Null when it could not be found. */
  zone: Type.Union([Type.String(), Type.Null()]),
  /** The zone's name servers are Cloudflare's. */
  cloudflareManaged: Type.Boolean(),
  /**
   * Link to the zone's DNS page on the Cloudflare dashboard (opens the
   * account picker), for the "Open Cloudflare DNS" button. Null when the
   * zone is not on Cloudflare.
   */
  cloudflareDnsUrl: Type.Union([Type.String(), Type.Null()]),
  /**
   * The origin check run with this DNS check (see Domain.origin): set by
   * domains.checkDns for a custom domain whose status is ok or proxied,
   * absent otherwise.
   */
  origin: Type.Optional(OriginStatus),
  /** Why that origin check did not reach the node, when Cloudflare said (see OriginReason). */
  originReason: Type.Optional(OriginReason),
  checkedAt: Timestamp,
});

const byService = <Input extends { serviceId: string }>(action: `${string}.${string}`) =>
  permission.service(action, (input: Input) => input.serviceId);

const DomainRef = { serviceId: Id, domainId: Id };

export const list = defineOp({
  id: "domains.list",
  kind: "query",
  summary: "List a service's domains",
  description:
    "Lists the domains of a service, primary first, with DNS and certificate status. Also says which automatic domain can be added from the node's wildcard record, if any.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    domains: Type.Array(Domain),
    /** Host domains.addAuto would create, for example web.de1.example.com. Null when the service's node has no wildcard domain. */
    autoDomainSuggestion: Type.Union([Hostname, Type.Null()]),
  }),
  permission: byService("domains.view"),
  mcp: true,
  audit: false,
});

export const addAuto = defineOp({
  id: "domains.addAuto",
  kind: "mutation",
  summary: "Add an automatic domain",
  description:
    "Adds <name>.<wildcard> from the wildcard A record of the node the service runs on. Works right away with no DNS change. Fails when the node has no wildcard domain set, and on a compose stack or a cron service (reason stackParent or cronService): a stack's domains go on its members.",
  input: Type.Object({
    serviceId: Id,
    /** Left-most label; defaults to the service name. */
    subdomain: Type.Optional(Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" })),
    /** Defaults to the service's main port. */
    targetPort: Type.Optional(ContainerPort),
  }),
  output: Domain,
  permission: byService("domains.edit"),
  mcp: true,
  audit: true,
});

export const add = defineOp({
  id: "domains.add",
  kind: "mutation",
  summary: "Add a custom domain",
  description:
    "Adds a custom domain (and optional path) to a service and returns it together with the DNS record to create. The route goes live once DNS points at the service's node and a certificate is issued. Until the panel sees the domain reach the node, its certificate waits (certificate.waitingForDns) and the node serves it over plain HTTP, without the redirect to HTTPS. Set forward to make it a redirect-only domain, for example www to the apex. When its DNS is ok or proxied, the panel checks a few seconds later, once the node has the route, that the domain reaches the node (the domain's origin in domains.list); for a service that has not deployed yet (domain.noRoute) it checks once a deployment goes live. Refused on a compose stack, which runs no container of its own (put the domain on the member that serves it), and on a cron service (reason stackParent or cronService).",
  input: Type.Object({
    serviceId: Id,
    host: Hostname,
    pathPrefix: Type.Optional(PathPrefix),
    stripPrefix: Type.Optional(Type.Boolean()),
    /** Defaults to the service's main port. */
    targetPort: Type.Optional(ContainerPort),
    https: Type.Optional(HttpsMode),
    forward: Type.Optional(DomainForward),
    /** Make it the primary domain right away. */
    primary: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({ domain: Domain, dns: DnsCheck }),
  permission: byService("domains.edit"),
  mcp: true,
  audit: true,
});

export const checkDns = defineOp({
  id: "domains.checkDns",
  kind: "query",
  summary: "Check a domain's DNS",
  description:
    "Resolves the domain through public resolvers now and classifies the answer (ok, missing, wrong target, Cloudflare proxied). Returns the records to create and a Cloudflare DNS link when the zone is on Cloudflare. For a custom domain that is ok or proxied it also checks that requests to it reach the service's node (origin: node, elsewhere or unknown), which tells whether a Cloudflare-proxied record points at the node; not while the service's nodes cannot have a route for it (Domain.noRoute notDeployed, stackParent or cronService). Also refreshes the stored status, and when the check shows a domain whose certificate waits for DNS reaching the node, the node asks Let's Encrypt for it right away.",
  input: Type.Object(DomainRef),
  output: DnsCheck,
  permission: byService("domains.view"),
  mcp: true,
  audit: false,
});

export const update = defineOp({
  id: "domains.update",
  kind: "mutation",
  summary: "Change a domain's routing",
  description:
    "Changes path prefix, strip prefix, target port, HTTPS mode, the HTTP to HTTPS redirect or the forward target of a domain. Fields left out keep their value; forward null turns a redirect-only domain back into a normal one. Refused on a compose stack or a cron service (reason stackParent or cronService), whose domains route nowhere: remove them there and add them to the service that serves the requests.",
  input: Type.Object({
    ...DomainRef,
    pathPrefix: Type.Optional(PathPrefix),
    stripPrefix: Type.Optional(Type.Boolean()),
    targetPort: Type.Optional(ContainerPort),
    https: Type.Optional(HttpsMode),
    redirectToHttps: Type.Optional(Type.Boolean()),
    forward: Type.Optional(Type.Union([DomainForward, Type.Null()])),
  }),
  output: Domain,
  permission: byService("domains.edit"),
  mcp: true,
  audit: true,
});

export const BasicAuthUserInput = Type.Object({
  username: Type.String({ minLength: 1, maxLength: 64, pattern: "^[^:\\s]+$" }),
  /** Plain text in, bcrypt hash stored. Leave out to keep an existing user's password. */
  password: Type.Optional(Type.String({ minLength: 8, maxLength: 200 })),
});

export const setMiddlewares = defineOp({
  id: "domains.setMiddlewares",
  kind: "mutation",
  summary: "Set a domain's access rules",
  description:
    "Sets basic auth, the IP allowlist, the rate limit and URL redirects of one domain. Each field left out keeps its value; null (or an empty list) turns it off. Basic auth users replace the whole list; a user without a password keeps the stored one.",
  input: Type.Object({
    ...DomainRef,
    basicAuth: Type.Optional(
      Type.Union([Type.Object({ users: Type.Array(BasicAuthUserInput, { minItems: 1, maxItems: 50 }) }), Type.Null()]),
    ),
    ipAllowList: Type.Optional(Type.Array(Cidr, { maxItems: 200 })),
    rateLimit: Type.Optional(Type.Union([DomainRateLimit, Type.Null()])),
    redirects: Type.Optional(Type.Array(DomainRedirect, { maxItems: 50 })),
  }),
  output: Domain,
  sensitive: { input: ["basicAuth.users.*.password"] },
  permission: byService("domains.edit"),
  mcp: true,
  audit: true,
});

export const setCertificate = defineOp({
  id: "domains.setCertificate",
  kind: "mutation",
  summary: "Upload a custom certificate",
  description:
    "Stores a PEM certificate chain and private key for a domain and switches it to HTTPS mode custom. Fails when the key does not match the certificate or the certificate does not cover the host.",
  input: Type.Object({
    ...DomainRef,
    certPem: Type.String({ minLength: 100, maxLength: 65536 }),
    privateKey: Type.String({ minLength: 100, maxLength: 65536, description: "PEM private key." }),
  }),
  output: Domain,
  sensitive: { input: ["privateKey"] },
  permission: byService("domains.edit"),
  mcp: false,
  audit: true,
});

export const setPrimary = defineOp({
  id: "domains.setPrimary",
  kind: "mutation",
  summary: "Make a domain primary",
  description:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${{svc.VAR}} is the reference syntax, not a template
    "Makes this the service's primary domain: IP:port access redirects here once it is live, and ${{svc.URL}} references resolve to it. The previous primary stays as a normal domain.",
  input: Type.Object(DomainRef),
  output: Domain,
  permission: byService("domains.edit"),
  mcp: true,
  audit: true,
});

export const retryCertificate = defineOp({
  id: "domains.retryCertificate",
  kind: "mutation",
  summary: "Regenerate a domain's certificate",
  description:
    "Asks Let's Encrypt again for the certificate of a domain whose certificate is pending or failed, without restarting the node's proxy: every other domain keeps serving. The domain's DNS must point at the service's node (it is checked now and the op refuses otherwise); behind Cloudflare's proxy the origin check runs too, and the op refuses (reason originElsewhere) while something other than the node answers, and (reason waitingForDns) while a domain whose certificate waits for DNS is not seen reaching the node; when the check shows it reaching the node, the certificate starts. Refused (reason notDeployed, stackParent or cronService, as in Domain.noRoute) while the service's nodes cannot have a route for the domain. Allowed once a minute per domain. Let's Encrypt itself allows 5 failed validations per host name per hour, so fix what the last error names before trying again. The domain shows certificate status pending until the node reports a certificate or a new failure.",
  input: Type.Object(DomainRef),
  output: Domain,
  permission: byService("domains.edit"),
  mcp: true,
  audit: true,
});

export const remove = defineOp({
  id: "domains.remove",
  kind: "destructive",
  summary: "Remove a domain",
  description:
    "Removes a domain from the service; requests to it stop reaching the service right away. When it was primary, the oldest remaining domain becomes primary.",
  input: Type.Object(DomainRef),
  output: Empty,
  permission: byService("domains.edit"),
  mcp: true,
  audit: true,
});

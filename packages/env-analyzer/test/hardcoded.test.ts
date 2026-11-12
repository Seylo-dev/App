import { describe, expect, test } from "bun:test";
import { type AnalyzeContext, analyzeEnv, appVariables, databaseVariables, type ReferenceVariable } from "../src";

const fsn = { id: "n1", name: "de-fsn-1" };
const ash = { id: "n2", name: "us-ash-1" };

/** An app's built-ins as env.references fills them. */
function appBuiltins(name: string, host: string, port: string): ReferenceVariable[] {
  const values: Record<string, string> = {
    URL: host ? `https://${host}` : "",
    DOMAIN: host,
    INTERNAL_URL: `http://${name}:${port}`,
    INTERNAL_HOST: name,
    INTERNAL_PORT: port,
  };
  return appVariables.map((v) => ({ ...v, value: values[v.name] ?? "" }));
}

// web (the edited service) and api on de-fsn-1, a Postgres exposed through a host name, a worker without a domain.
const context: AnalyzeContext = {
  self: { serviceId: "web", name: "web", nodes: [fsn], builtins: appBuiltins("web", "shop.example.com", "8080") },
  targets: [
    {
      name: "api",
      kind: "service",
      serviceId: "apiid",
      serviceKind: "app",
      nodes: [fsn],
      internalHost: "api",
      exposed: true,
      variables: [
        ...appBuiltins("api", "api.example.com", "3000"),
        // The target's own variable with a built-in's shape is not a built-in.
        { name: "PUBLIC_NAME", value: "https://api.example.com", scope: "plain", sensitive: true, description: "variable of this service" },
      ],
    },
    {
      name: "worker",
      kind: "service",
      serviceId: "workerid",
      serviceKind: "app",
      nodes: [fsn],
      internalHost: "worker",
      exposed: false,
      variables: appBuiltins("worker", "", "9000"),
    },
    {
      name: "db",
      kind: "service",
      serviceId: "dbid",
      serviceKind: "postgres",
      nodes: [fsn],
      internalHost: "db",
      exposed: true,
      variables: databaseVariables.map((v) => ({
        ...v,
        value:
          (
            {
              INTERNAL_URL: "postgres://app:s3cr3t-pw@db:5432/shop",
              INTERNAL_HOST: "db",
              INTERNAL_PORT: "5432",
              EXPOSED_URL: "postgres://app:s3cr3t-pw@pg.example.com:15432/shop?sslmode=require",
              EXPOSED_HOST: "203.0.113.10",
              EXPOSED_PORT: "15432",
            } as Record<string, string>
          )[v.name] ?? "x",
      })),
    },
    {
      name: "project",
      kind: "shared",
      serviceId: null,
      serviceKind: null,
      nodes: [],
      internalHost: null,
      exposed: false,
      variables: [{ name: "URL", value: "https://docs.example.com", scope: "plain", sensitive: true, description: "shared variable" }],
    },
  ],
};

const hints = (text: string, ctx: AnalyzeContext = context) =>
  analyzeEnv(text, ctx).diagnostics.filter((d) => d.code === "hardcoded-reference");

/** [matched text, suggested reference] per hint. */
const found = (text: string, ctx: AnalyzeContext = context) =>
  hints(text, ctx).map((d) => [text.slice(d.range.start, d.range.end), d.params.reference]);

/** The text after applying every hint's first fix. */
function fixed(text: string): string {
  const edits = hints(text).flatMap((d) => (d.fixes[0]?.kind === "edit" ? d.fixes[0].edits : []));
  let out = text;
  for (const e of [...edits].sort((a, b) => b.range.start - a.range.start))
    out = out.slice(0, e.range.start) + e.text + out.slice(e.range.end);
  return out;
}

describe("hardcoded-reference", () => {
  test("a value equal to a target's built-in, as an info hint with the reference as its fix", () => {
    const text = "API_URL=https://api.example.com\nAPI_DOMAIN=api.example.com\nAPI_INTERNAL=http://api:3000\nAPI_HOST=api\n";
    expect(found(text)).toEqual([
      ["https://api.example.com", "${{api.URL}}"],
      ["api.example.com", "${{api.DOMAIN}}"],
      ["http://api:3000", "${{api.INTERNAL_URL}}"],
      ["api", "${{api.INTERNAL_HOST}}"],
    ]);
    const [first] = hints(text);
    expect(first).toMatchObject({
      severity: "info",
      message: "API_URL can use ${{api.URL}}",
      fixes: [{ kind: "edit", title: "Use ${{api.URL}}" }],
    });
    expect(fixed(text)).toBe(
      "API_URL=${{api.URL}}\nAPI_DOMAIN=${{api.DOMAIN}}\nAPI_INTERNAL=${{api.INTERNAL_URL}}\nAPI_HOST=${{api.INTERNAL_HOST}}\n",
    );
  });

  test("a URL followed by a path, query or fragment keeps the rest", () => {
    const text =
      "A=https://api.example.com/v1/users\nB=https://api.example.com?x=1\nC=http://api:3000#top\nD=https://api.example.com.evil.test\nE=https://api.example.com:8443/v1\n";
    expect(found(text)).toEqual([
      ["https://api.example.com", "${{api.URL}}"],
      ["https://api.example.com", "${{api.URL}}"],
      ["http://api:3000", "${{api.INTERNAL_URL}}"],
    ]);
    expect(fixed(text)).toStartWith(
      "A=${{api.URL}}/v1/users\nB=${{api.URL}}?x=1\nC=${{api.INTERNAL_URL}}#top\nD=https://api.example.com.evil.test\n",
    );
  });

  test("a trailing slash is ignored and kept, so the value stays the same", () => {
    expect(fixed("A=https://api.example.com/\n")).toBe("A=${{api.URL}}/\n");
    // A built-in that ends in a slash takes the value's slash with it.
    const slashed: AnalyzeContext = {
      ...context,
      targets: [{ ...(context.targets[0] as (typeof context.targets)[0]), variables: appBuiltins("api", "api.example.com/", "3000") }],
    };
    expect(found("A=https://api.example.com/v1\nB=https://api.example.com\n", slashed)).toEqual([
      ["https://api.example.com/", "${{api.URL}}"],
      ["https://api.example.com", "${{api.URL}}"],
    ]);
  });

  test("scheme and host compare case-insensitively, user info and path exactly", () => {
    expect(found("A=HTTPS://API.Example.COM/v1\nAPI_DOMAIN=api.EXAMPLE.com\n")).toEqual([
      ["HTTPS://API.Example.COM", "${{api.URL}}"],
      ["api.EXAMPLE.com", "${{api.DOMAIN}}"],
    ]);
    expect(found("DATABASE_URL=postgres://APP:s3cr3t-pw@db:5432/shop\nC=postgres://app:s3cr3t-pw@db:5432/SHOP\n")).toEqual([]);
    expect(found("DATABASE_URL=postgres://app:s3cr3t-pw@DB:5432/shop?pool=5\n")).toEqual([
      ["postgres://app:s3cr3t-pw@DB:5432/shop", "${{db.INTERNAL_URL}}"],
    ]);
  });

  test("the service's own built-ins: its URL as ${{<self>.URL}}", () => {
    const text = "NEXTAUTH_URL=https://shop.example.com\nCALLBACK=https://shop.example.com/auth/callback\n";
    expect(found(text)).toEqual([
      ["https://shop.example.com", "${{web.URL}}"],
      ["https://shop.example.com", "${{web.URL}}"],
    ]);
    // Its own address is meant to be public: no word about INTERNAL_URL.
    expect(hints(text)[0]?.params.internalReference).toBe("");
    expect(hints(text)[0]?.detail).not.toContain("INTERNAL_URL");
  });

  test("browser variables get the public variable; server ones hear about INTERNAL_URL", () => {
    const text =
      "NEXT_PUBLIC_API=https://api.example.com/v1\nVITE_API=http://api:3000/v1\nAPI=https://api.example.com/v1\nINTERNAL=http://api:3000\n";
    expect(found(text)).toEqual([
      ["https://api.example.com", "${{api.URL}}"],
      // The internal address does not work in a browser: the fix switches to the public one.
      ["http://api:3000", "${{api.URL}}"],
      ["https://api.example.com", "${{api.URL}}"],
      ["http://api:3000", "${{api.INTERNAL_URL}}"],
    ]);
    const [next, vite, server, internal] = hints(text);
    expect(next?.detail).toContain("A server-side variable can use ${{api.INTERNAL_URL}} instead when both services share a node.");
    expect(next?.params).toMatchObject({ reason: "same", browser: "true", internalReference: "${{api.INTERNAL_URL}}" });
    expect(vite?.detail).toContain("VITE_API is read in the browser, which cannot reach api's internal address");
    expect(vite?.params).toMatchObject({ reason: "public", matched: "INTERNAL_URL", variable: "URL" });
    expect(server?.detail).toContain("Read on the server, API can also use ${{api.INTERNAL_URL}} when both services share a node.");
    expect(server?.params).toMatchObject({ reason: "same", browser: "false" });
    expect(internal?.detail).not.toContain("server");
    for (const prefix of ["REACT_APP_", "NUXT_PUBLIC_", "EXPO_PUBLIC_", "GATSBY_", "VUE_APP_", "PUBLIC_"]) {
      expect(hints(`${prefix}API=http://api:3000\n`)[0]?.params.reference).toBe("${{api.URL}}");
    }
  });

  test("a browser variable with the internal address of a service without a public one: no fix, no internal reference", () => {
    const noDomain = hints("VITE_WORKER=http://worker:9000/jobs\n")[0];
    expect(noDomain).toMatchObject({
      severity: "info",
      message: "VITE_WORKER uses worker's internal address, which browsers cannot reach",
      detail:
        "VITE_WORKER is read in the browser, which cannot reach worker's internal address. Give worker a public address, then use ${{worker.URL}}.",
      params: { reason: "noPublic", matched: "INTERNAL_URL", reference: "", internalReference: "", publicReference: "${{worker.URL}}" },
      fixes: [],
    });
    // Nothing a model could apply that a browser cannot use.
    expect(JSON.stringify(noDomain)).not.toContain("INTERNAL_URL}}");
    // A server-side variable still gets the internal reference.
    expect(found("WORKER=http://worker:9000/jobs\n")).toEqual([["http://worker:9000", "${{worker.INTERNAL_URL}}"]]);
  });

  test("the message, detail and params name the key and the reference, never the value", () => {
    const text =
      "DATABASE_URL=postgres://app:s3cr3t-pw@pg.example.com:15432/shop?sslmode=require&token=abc123\nNEXT_PUBLIC_API=https://api.example.com/hooks/T000/secret-path\n";
    const all = hints(text);
    expect(all.map((d) => d.params.reference)).toEqual(["${{db.EXPOSED_URL}}", "${{api.URL}}"]);
    for (const d of all) {
      const shown = JSON.stringify([d.message, d.detail, d.params, d.fixes]);
      for (const secret of ["s3cr3t-pw", "pg.example.com", "token=abc123", "secret-path", "api.example.com"]) {
        expect(shown).not.toContain(secret);
      }
    }
  });

  test("no hint inside references, for empty values or built-ins, generic hosts, or shared variables", () => {
    expect(found("A=${{api.URL}}\nB=${{api.URL}}/v1\nC=\nD=''\nE=https://docs.example.com\n")).toEqual([]);
    // worker has no domain: its empty URL and DOMAIN never match.
    expect(found("W=https://\nX=https:///\n")).toEqual([]);
    const generic: AnalyzeContext = {
      ...context,
      targets: [
        {
          name: "local",
          kind: "service",
          serviceId: "l",
          serviceKind: "app",
          nodes: [fsn],
          internalHost: "local",
          exposed: true,
          variables: [
            { name: "DOMAIN", value: "localhost", scope: "public", sensitive: false, description: "" },
            { name: "URL", value: "http://localhost", scope: "public", sensitive: false, description: "" },
            { name: "EXPOSED_HOST", value: "203.0.113.10", scope: "public", sensitive: false, description: "" },
            { name: "INTERNAL_URL", value: "http://203.0.113.10", scope: "internal", sensitive: false, description: "" },
            { name: "INTERNAL_HOST", value: "8080", scope: "internal", sensitive: false, description: "" },
          ],
        },
      ],
    };
    expect(found("A=localhost\nB=http://localhost/x\nC=203.0.113.10\nD=http://203.0.113.10\nHOST=8080\n", generic)).toEqual([]);
    // The database's exposed IP is shared by every exposed database on the node.
    expect(found("PG_HOST=203.0.113.10\n")).toEqual([]);
  });

  test("a host name alone counts only for keys that name a host or a domain", () => {
    expect(found("QUEUE_CONNECTION=api\nDRIVER=db\nAPI_HOST=api\nDB_HOSTNAME=db\nREDIS_ADDR=api\nPGHOST=db\n")).toEqual([
      ["api", "${{api.INTERNAL_HOST}}"],
      ["db", "${{db.INTERNAL_HOST}}"],
      ["api", "${{api.INTERNAL_HOST}}"],
      ["db", "${{db.INTERNAL_HOST}}"],
    ]);
    // With a dot too: the same name in a key that is not about a host is a coincidence.
    expect(found("NOTE=api.example.com\nAPP_NAME=shop.example.com\n")).toEqual([]);
    expect(found("ALLOWED_HOSTS=shop.example.com\nCOOKIE_DOMAIN=shop.example.com\nSERVER_NAME=api.example.com\n")).toEqual([
      ["shop.example.com", "${{web.DOMAIN}}"],
      ["shop.example.com", "${{web.DOMAIN}}"],
      ["api.example.com", "${{api.DOMAIN}}"],
    ]);
    // A mail domain reads like a site's domain but is its own setting; an internal mail host is still that service.
    expect(found("MAIL_DOMAIN=shop.example.com\nMAILGUN_DOMAIN=shop.example.com\nSMTP_HOST=api.example.com\nSMTP_HOST=api\n")).toEqual([
      ["api", "${{api.INTERNAL_HOST}}"],
    ]);
  });

  test("a database's EXPOSED_HOST alone is not matched: it can be the node's address, shared by everything on it", () => {
    // db exposed through the node's DNS name, no TLS host name of its own.
    const onNode: AnalyzeContext = {
      ...context,
      targets: context.targets.map((t) =>
        t.name !== "db"
          ? t
          : {
              ...t,
              variables: t.variables.map((v) =>
                v.name === "EXPOSED_HOST"
                  ? { ...v, value: "de1.host.net" }
                  : v.name === "EXPOSED_URL"
                    ? { ...v, value: "postgres://app:s3cr3t-pw@de1.host.net:15432/shop?sslmode=require" }
                    : v,
              ),
            },
      ),
    };
    expect(found("SSH_HOST=de1.host.net\nPGHOST=de1.host.net\nSFTP_SERVER=DE1.host.net\n", onNode)).toEqual([]);
    // The connection URL, with its port and user, is that database.
    expect(found("DATABASE_URL=postgres://app:s3cr3t-pw@de1.host.net:15432/shop?sslmode=require\n", onNode)).toEqual([
      ["postgres://app:s3cr3t-pw@de1.host.net:15432/shop?sslmode=require", "${{db.EXPOSED_URL}}"],
    ]);
  });

  test("the same address on two services is not guessed", () => {
    const twin: AnalyzeContext = {
      ...context,
      targets: [
        ...context.targets,
        {
          name: "api2",
          kind: "service",
          serviceId: "api2",
          serviceKind: "app",
          nodes: [fsn],
          internalHost: "api2",
          exposed: true,
          variables: appBuiltins("api2", "api.example.com", "3000"),
        },
      ],
    };
    expect(found("A=https://api.example.com\n", twin)).toEqual([]);
  });

  test("an internal address of a service on another node is left to the cross-node error", () => {
    const far: AnalyzeContext = { ...context, self: { ...context.self, nodes: [ash] } };
    const codes = analyzeEnv("A=http://api:3000\nB=https://api.example.com\n", far).diagnostics.map((d) => [d.code, d.range.startLine]);
    expect(codes).toEqual([
      ["internal-address-other-node", 1],
      ["hardcoded-reference", 2],
    ]);
  });

  test("quoted values: the fix stays inside double quotes, single quotes become double ones", () => {
    expect(fixed('A="https://api.example.com/v1" # api\nexport B=`http://api:3000`\n')).toBe(
      'A="${{api.URL}}/v1" # api\nexport B=`${{api.INTERNAL_URL}}`\n',
    );
    expect(fixed("A='https://api.example.com/v1'\n")).toBe('A="${{api.URL}}/v1"\n');
    // A rest that reads differently in double quotes gets the hint without a fix.
    const raw = hints("A='https://api.example.com/a\"b'\n");
    expect(raw.map((d) => d.fixes)).toEqual([[]]);
    // Syntax problems first: no hint on a broken line.
    expect(found('A="https://api.example.com\n')).toEqual([]);
  });
});

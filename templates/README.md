# Templates

One-click templates for the panel. Each folder is one template in the same
shape Easypanel uses: `meta.yaml` (name, description, the install form) and
`index.ts` with a `generate(input)` function that returns the services to
create. This catalog is written for this project; nothing is copied from
other catalogs.

Template code never runs in the panel's own JavaScript engine. The panel
compiles `index.ts` and runs it in a QuickJS WebAssembly sandbox
(`apps/panel/src/template-runner`) with no network, files, timers or host
objects, a 32 MiB memory cap and a 1 second time limit. The result is
checked against a schema and shown as a list of services before anything is
created.

## meta.yaml

```yaml
name: "n8n"
description: "One line for the card."
category: "Automation"          # Analytics, CMS, Databases, Developer tools, Monitoring, ...
tags: ["automation"]
creates: "App + Postgres"       # shown on the card
links:
  - label: "Docs"
    url: "https://docs.n8n.io"
body: |
  Markdown shown in the install dialog.
schema:                          # the install form (JSON Schema subset)
  type: object
  required: ["image"]
  properties:
    image:
      type: "string"
      title: "Image"
      default: "n8nio/n8n:1.80.0"
    adminPassword:
      type: "string"
      format: "password"         # generated when left empty
      title: "Admin password"
    plan:
      type: "string"
      enum: ["small", "large"]   # a select
```

Field types: `string`, `number`/`integer`, `boolean`; `format: password`
(generated when empty) and `format: domain`; `enum` makes a select. The
panel always asks for the service name and the node; `generate` receives
them as `input.serviceName` and `input.projectName` next to the form values.

## index.ts

```ts
import { env, PRIMARY_DOMAIN, randomHex, ref } from "~templates-utils";

export function generate(input: { serviceName: string; image: string }) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "app" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({ DATABASE_URL: ref(db, "INTERNAL_URL"), SECRET: randomHex(32) }),
          domains: [{ host: PRIMARY_DOMAIN, port: 3000 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/data" }],
        },
      },
    ],
  };
}
```

Service types: `app` (an image with env, domains, volume and file mounts,
extra ports and an optional `deploy.command`, which replaces the image's
entrypoint and runs in `/bin/sh -c`) and the databases `postgres`, `mysql`,
`mariadb`, `mongo` and `redis` (`version`, `database`, `user`, `password`;
created like any database, with web UI, shell and backups).

`~templates-utils` gives `randomPassword(n)`, `randomString(n)`,
`randomHex(bytes)`, `randomBase64(bytes)`, `env({...})` (KEY=value lines),
`ref(service, VARIABLE)` (a `${{service.VARIABLE}}` reference the panel
resolves on every deploy, so a reset database password reaches the app) and
`PRIMARY_DOMAIN` (the node's automatic domain). Database services offer
`INTERNAL_URL`, `INTERNAL_HOST`, `INTERNAL_PORT`, `USER`, `PASSWORD` and
`DATABASE`; apps offer `URL`, `DOMAIN` and `INTERNAL_URL`.

Pin image tags. Every template is run by
`apps/panel/test/templates.test.ts`, which checks the output and that each
template installs.

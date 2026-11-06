# @seylo/ops

The operation registry. Every action the panel offers is defined once here
as a contract, and everything else is derived from it: the REST route, the
OpenAPI document (`openapi.json`), MCP tools, AI assistant tools, the typed
web client and the audit log entry.

## Adding an op

1. Define the contract in `src/ops/<module>.ts` with `defineOp`. The id is
   `<module>.<action>`; the module is the file name.

   ```ts
   export const restart = defineOp({
     id: "services.restart",
     kind: "mutation",
     summary: "Restart a service",
     description: "Restarts every replica of the service without a new deploy.",
     input: Type.Object({ serviceId: Id }),
     output: Empty,
     permission: permission.service("services.restart", (input: { serviceId: string }) => input.serviceId),
     mcp: true,
     audit: true,
   });
   ```

2. Implement it in the panel: `apps/panel/src/modules/<module>/<action>.ts`
   with `implement(contract, run)`, listed in that module's `index.ts`.
3. Run `make gen` (regenerates the module indexes and `openapi.json`).
4. `bun test` here checks the contract rules; `bun test` in `apps/panel`
   checks that every contract has exactly one handler.

## Rules (enforced by `lintOp`)

- A summary and a description that says what the op does.
- An explicit permission: `public`, `signedIn`, `global(action)`,
  `project(action, id)` or `service(action, id)`.
- Mutations and destructive ops are audited.
- Fields whose names end in password, secret, token, apiKey, privateKey or
  credential(s) are listed in `sensitive`, so audit logs, approvals and model
  transcripts redact them.
- Query inputs are flat scalars (they travel in the query string).
- Schemas are plain JSON: no `Type.Date`, `Type.Uint8Array` and so on;
  timestamps are `Timestamp` strings. Every string `format` is registered in
  `src/formats.ts`.

## Entry points

| Import | What |
|---|---|
| `@seylo/ops` | Contracts by module (`projects.create`), `allOps`, `defineOp`, `permission`, `OpError`, `redact`, the live socket protocol |
| `@seylo/ops/client` | `createOpClient`: typed fetch client |
| `@seylo/ops/react` | `useOp` (queries), `useOpMutation`, `opQueryKey`, `OpClientProvider` |
| `@seylo/ops/elysia` | `opRoutes`: mounts one route per op on Elysia (panel only) |
| `@seylo/ops/generators` | `buildOpenApi`, `buildMcpTools`, `buildAiTools` |

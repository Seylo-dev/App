# @seylo/web

The web app: Vite, React 19, TanStack Router (file-based) and Query,
Tailwind 4 with the `@seylo/ui` kit, Tabler icons, Geist.

## Run it

Start the panel (`bun run dev` in `apps/panel`), then `bun run dev` here and
open http://localhost:5173. Vite proxies `/api` (including both
WebSockets) to `PANEL_URL` (default http://localhost:3000). `bun run build`
writes `dist/`, which the panel serves.

## How it fits together

- Data: only through ops. `useOp(projects.list, {})` for queries,
  `useOpMutation(projects.create)` for changes. Types come from the
  contracts in `@seylo/ops`.
- Live updates: `useLiveTopic("project:<id>")` follows a topic; when the
  panel says an op's results changed, those queries refetch (`src/lib/live.ts`).
- Routes: files in `src/routes` (`_app` is the signed-in layout with the
  sidebar). `bun run routes` regenerates `src/routeTree.gen.ts`; `make gen`
  and the Vite plugin do it too.
- Strings: every visible string goes through `t("section.key")`. Each
  section is a file in `src/i18n/en/`; `make gen` lists them in
  `src/i18n/en/index.gen.ts`.
- Styling: tokens and Tailwind utilities from `@seylo/ui`; no literal colors.
- Errors: an op the panel answers with 501 NOT_IMPLEMENTED shows "Not built
  yet" in place (`src/components/query-error.tsx`), never an empty screen.

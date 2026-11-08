# @seylo/ui

The panel's UI kit: shadcn/ui-style components (Radix primitives, `cva`
variants) restyled to the approved design, plus the design tokens.

- `src/styles/theme.css`: every color, radius and shadow as a CSS
  variable, with the theme presets (`seylo`, `seylo-night`, `classic`,
  `midnight`) selected by `<html data-theme>`. Restyling means overriding
  variables, never editing components. Terminal surfaces and the 16 ANSI
  colors (`--ansi-0` .. `--ansi-15`) stay dark in every preset.
- `src/styles/tailwind.css`: maps the tokens to Tailwind utilities
  (`bg-card`, `shadow-card`, `rounded-control`, `bg-chip-green-bg`, ...).
  Apps import it after `@import "tailwindcss"` and `tw-animate-css`, and add
  `@source "<path to>/packages/ui/src"`.
- `src/components/*`: one component per file. Import from the package root
  (`import { Button, DataTable } from "@seylo/ui"`) or one file
  (`@seylo/ui/components/button`).

Components never use literal colors; add a token first. They hold no
English either: see "Setup".

Every component renders with sample data at `/dev/kit` in the web app
(`apps/web/src/routes/dev.kit.tsx`). Check new work there in all four
presets.

## Setup (once, at the app root)

```tsx
<UiLabelsProvider labels={uiLabels()}>   {/* the kit's words from the i18n catalog */}
  <TooltipProvider>
    <App />
    <Toaster />
  </TooltipProvider>
</UiLabelsProvider>
```

The web app already does this in `main.tsx`; the strings are the `kit`
i18n section. Without the provider each label shows its own key.

## Components

| File | What | Notes |
|---|---|---|
| `button` | `Button` primary, secondary, ghost, destructive, dark; sizes default, sm, icon | `asChild` for router links |
| `card` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` | white, radius 12, soft shadow, no border |
| `section-card` | `SectionCard` title, description, actions, footer | settings and detail sections; `flush` for edge-to-edge tables; `danger` |
| `page-header` | `PageHeader` title, subtitle, breadcrumb, leading, actions | the top of every screen |
| `chip` | `Chip` tinted labels, `StatusDot` | tones blue, sky, red, violet, gray, green, amber, track |
| `alert` | `Alert` / `Callout` info, success, warning, danger, neutral | optional title and action |
| `empty-state` | `EmptyState` icon, title, description, action | `compact` inside tables |
| `key-value` | `KeyValue` rows or grid of label and value | `mono` values; long values wrap, never an ellipsis |
| `stat-tile` | `StatTile` label, value, unit, delta, sparkline | `bare` inside another card |
| `data-table` | `DataTable` sortable columns, empty state, skeleton rows, row-actions menu, row click | client-side sort (`lib/sort`), `minWidth` scrolls sideways |
| `input`, `textarea` | `Input`, `Label`, `Textarea` (`mono`) | |
| `select` | `Select`, `SelectTrigger` (size sm, `loading`), `SelectContent`, `SelectItem`, ... | looks like `Input`; `loading` shows a skeleton line until the options are in, never a "Loading" placeholder |
| `switch`, `checkbox`, `radio-group` | `Switch` (size sm), `Checkbox` (indeterminate), `RadioGroup`, `RadioGroupItem`, `RadioCard` | `RadioCard` for big choices (builders, plans) |
| `segmented` | `Segmented`, `SegmentedItem` | single-choice track (ranges, views) |
| `tabs` | `TabList`, `tabClassName` | underlined route tabs |
| `copy-field` | `CopyField` copies on click (or Enter/Space), never on focus alone; keyboard focus rings the whole field; `secret` masks with an eye toggle; `copyText`, `useCopy` | works on plain HTTP too |
| `code-block` | `CodeBlock` light or dark, title, copy, `wrap`; `CopyCode` an inline code chip that wraps, with a copy button | no syntax colors (Monaco edits); every command shown gets one of the two |
| `dropdown-menu` | `DropdownMenu*` items, checkbox/radio items, labels, separators, sub menus | `destructive` items |
| `popover`, `tooltip` | `Popover*`; `Tooltip*` and the `Tip` shorthand | |
| `dialog`, `sheet` | `Dialog*`; `Sheet*` right, left or bottom with header, body, footer | |
| `confirm-dialog` | `ConfirmDialog` with `destructive` and `confirmText` (type to confirm) | async `onConfirm`: busy while pending, stays open showing the error on reject |
| `toast` | `toast()`, `toast.success/error/warning/info/dismiss`, `<Toaster />` | call from anywhere; reuse `id` to update a toast in place |
| `progress` | `Progress` (value or indeterminate), `usageTone(percent)` | |
| `avatar` | `Avatar` image or tinted initials | |
| `skeleton`, `kbd`, `command` | loading blocks, key caps, the command palette | |
| `smooth-chart` | `SmoothChart`, `ChartLegend`, `toggleHidden`, `seriesColor` | Catmull-Rom lines + light areas (`lib/smooth-path`), hover tooltip, lines draw in once; one legend can drive several charts through `hidden` |
| `sparkline` | `Sparkline` | tiny trend for tiles and cells |
| `log-viewer` | `LogViewer`, `useLogBuffer`, `LogBuffer` | see below |
| `labels` | `UiLabelsProvider`, `useUiLabels`, `UiLabels` | the kit's own words |

## LogViewer

Lines live in a `LogBuffer`, a ring outside React (default 10,000 lines).
Push from anywhere, as fast as they come:

```ts
const buffer = useLogBuffer();                    // or new LogBuffer(capacity) in a store
socket.onmessage = (e) => buffer.push({ text: e.data, ts: Date.now(), source: "build", level: "info" });
<LogViewer buffer={buffer} aria-label="Build log" height={480} showTimestamps title="Build log" actions={...} />
```

Subscribers are told at most once per animation frame, only the rows in
view are in the DOM (fixed row height, long lines scroll sideways), ANSI
colors are parsed once per line (`lib/ansi`), search highlights matches and
Enter / Shift+Enter jump between them, and follow mode sticks to the newest
line until the reader scrolls up (a "Jump to latest" button brings it back;
scrolling to the bottom resumes it). Lines that fall off the ring do not
move what the reader is looking at.

## Tests

`bun test` covers the logic that has no DOM: smooth paths (they match
`design/smoothpath.py`), ANSI parsing and highlight, the log ring and its
once-per-frame notify, sorting, and the toast store.

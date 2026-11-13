# @seylo/ui

The panel's UI kit: shadcn/ui-style components (Radix primitives, `cva`
variants) restyled to the approved design, plus the design tokens.

- `src/styles/theme.css`: every color, radius and shadow as a CSS
  variable, with the theme presets (`settings.themePresets` in
  `@seylo/ops`: `seylo`, `classic`, `midnight`, `graphite`, `clay`,
  `harbor`, `orchid`, `steel`, `marigold`, `meadow`) selected by
  `<html data-theme>`, each with a light half and a dark half picked by the
  `dark` class on `<html>`. Restyling means overriding variables, never
  editing components. Accent-colored tokens are mixed from `--primary`.
  Terminal surfaces and the 16 ANSI colors (`--ansi-0` .. `--ansi-15`)
  stay dark in every preset and half.
- `src/styles/tailwind.css`: maps the tokens to Tailwind utilities
  (`bg-card`, `shadow-card`, `rounded-control`, `bg-chip-green-bg`, ...).
  Apps import it after `@import "tailwindcss"` and `tw-animate-css`, and add
  `@source "<path to>/packages/ui/src"`.
- `src/components/*`: one component per file. Import from the package root
  (`import { Button, DataTable } from "@seylo/ui"`) or one file
  (`@seylo/ui/components/button`).

A row that may not fit (tabs on a phone, a view switcher in a sheet) gets
the `scroll-row` utility and `ref={scrollFadeRef}` (`lib/scroll-fade`): it
scrolls sideways without a scrollbar, and the edge that hides items fades
out. Rows people use with a mouse wrap from `md` up instead, so nothing
sits out of reach.

Components never use literal colors; add a token first. They hold no
English either: see "Setup".

Every component renders with sample data at `/dev/kit` in the web app
(`apps/web/src/routes/dev.kit.tsx`). Check new work there in every preset,
light and dark.

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
| `segmented` | `Segmented`, `SegmentedItem` | single-choice track (ranges, views); `ref` reaches the track |
| `tabs` | `TabList`, `tabClassName` | underlined route tabs; wraps by default |
| `copy-field` | `CopyField` copies on click (or Enter/Space), never on focus alone; keyboard focus rings the whole field; `secret` masks with an eye toggle; `copyText`, `useCopy` | works on plain HTTP too |
| `code-block` | `CodeBlock` light or dark, title, copy, wraps long lines (`noWrap` scrolls sideways); `CopyCode` an inline code chip that wraps, with a copy button | no syntax colors (Monaco edits); every command shown gets one of the two |
| `dropdown-menu` | `DropdownMenu*` items, checkbox/radio items, labels, separators, sub menus | `destructive` items |
| `context-menu` | `ContextMenu*`: the same parts as the dropdown, opened by right-click, touch long-press, the context menu key or Shift+F10 | same classes as the dropdown (`lib/menu-styles.ts`); see "Menus" |
| `menu-items` | `MenuEntry`, `MenuItems`, `RowContextMenu`, `ActionsMenu`, `tidyEntries`, `entryIds` | one entry list for a row's "..." and its right-click menu |
| `popover`, `tooltip` | `Popover*`; `Tooltip*` and the `Tip` shorthand | |
| `dialog`, `sheet` | `Dialog*`; `Sheet*` right, left or bottom with header, body, footer | |
| `confirm-dialog` | `ConfirmDialog` with `destructive` and `confirmText` (type to confirm) | async `onConfirm`: busy while pending, stays open showing the error on reject |
| `toast` | `toast()`, `toast.success/error/warning/info/dismiss`, `<Toaster />` | call from anywhere; reuse `id` to update a toast in place |
| `progress` | `Progress` (value or indeterminate), `usageTone(percent)` | |
| `avatar` | `Avatar` image or tinted initials | |
| `skeleton`, `kbd`, `command` | loading blocks, key caps, the command palette | |
| `smooth-chart` | `SmoothChart`, `ChartLegend`, `toggleHidden`, `seriesColor`, `ChartWindow` | Catmull-Rom lines + light areas (`lib/smooth-path`), hover tooltip, lines draw in once; one legend can drive several charts through `hidden`; `window` puts each series on its own `times` in a sliding time window (live graphs: a compositor animation between renders, a sticky nice y maximum, no sliding with reduced motion) |
| `sparkline` | `Sparkline` | tiny trend for tiles and cells |
| `log-viewer` | `LogViewer`, `useLogBuffer`, `LogBuffer` | see below |
| `labels` | `UiLabelsProvider`, `useUiLabels`, `UiLabels` | the kit's own words |

## Menus

An object's "..." menu and its right-click menu are one list of
`MenuEntry` (item, checkbox, sub menu, label, separator), built once and
handed to both:

```tsx
const entries: MenuEntry[] = [
  { type: "item", id: "restart", label: "Restart", icon: <IconRefresh size={15} />, onSelect: restart },
  { type: "item", id: "deploy", label: "Deploy", disabled: busy, disabledReason: "A deploy is in progress.", onSelect: deploy },
  { type: "separator", id: "sep:delete" },
  { type: "item", id: "delete", label: "Delete", destructive: true, onSelect: askToDelete },
];
<RowContextMenu entries={entries}>
  <a href="..." className="... data-[state=open]:bg-muted">api</a>   {/* the row itself is the trigger */}
</RowContextMenu>
<ActionsMenu entries={entries} trigger={<Button size="icon" aria-label="More actions">...</Button>} />
```

`MenuItems` renders the entries for either menu from the same function
(`menuElements`), so the two cannot differ; `tidyEntries` drops stray
separators and empty sub menus, and a disabled item's `disabledReason`
shows once as a note at the end of the menu (a disabled item takes no
pointer, so its title never shows). `RowContextMenu` puts the trigger on
the row's own element (`asChild`, no wrapper), which has
`data-state="open"` while the menu is open for its selected look; with no
entries it leaves the row alone. Give `items` instead of `entries` for a
menu that builds its entries when it opens (hooks allowed), so a long list
asks for nothing until one menu opens. Dialogs a menu opens are never
inside the menu or the row.

`ContextMenuTrigger` keeps the browser's own menu where it is the better
one: text fields, `.monaco-editor`, `.xterm`, anything inside
`[data-native-context-menu]`, a row with text selected in it (read on
pointerdown, before macOS selects the word under the pointer), anything
rendered into the row through a portal (a dialog), and Shift+right-click
anywhere. Nothing opens on `[data-no-context-menu]` (a drag grip), inside
an open menu, or while `blocked()` says so. The context menu key and
Shift+F10 open the menu at the focused element in every browser (macOS
has no such key). A touch or pen long-press follows the same rules
(`longPressDecision`): Radix opens the menu from a timer of its own (iOS
sends no contextmenu event), so a press where a right-click would open
none of ours keeps the trigger disabled until it lifts, which clears that
timer. On a touch screen the row takes no text selection or link callout
(`pointer-coarse:select-none`), and the browser's-menu places above get
both back (`styles/tailwind.css`). After a touch long-press opened it, the
tap the lifted finger leaves on the row is swallowed. When the menu
closes, focus goes back to what had it when the menu opened, unless an
item moved it somewhere since (an inline rename's field, a dialog:
`keepsFocusOnClose`). `contextMenuDecision`, `longPressDecision` and
`isMenuKey` are the pure rules (tested without a DOM).

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
once-per-frame notify, sorting, the toast store, and the menus (the same
items in both kinds, separators, the browser's menu or ours).

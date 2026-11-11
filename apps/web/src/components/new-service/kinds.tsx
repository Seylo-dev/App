// The kinds of the "New service" menu and the mono tag they show.

import { Chip, type ChipProps } from "@seylo/ui/components/chip";
import type { MessageKey } from "../../i18n/t";

export type NewServiceKind = "app" | "database" | "compose" | "template" | "dockerHub" | "box" | "cron" | "import";

/** Kinds that open a page (the catalog, the import page) instead of a create form. */
export type CatalogKind = "template" | "dockerHub" | "import";

export const newServiceKinds: readonly {
  kind: NewServiceKind;
  tag: string;
  tone: NonNullable<ChipProps["tone"]>;
  title: MessageKey;
  description: MessageKey;
}[] = [
  { kind: "app", tag: "APP", tone: "blue", title: "newService.app", description: "newService.appHint" },
  { kind: "database", tag: "DB", tone: "sky", title: "newService.database", description: "newService.databaseHint" },
  { kind: "compose", tag: "CMP", tone: "green", title: "newService.compose", description: "newService.composeHint" },
  { kind: "template", tag: "TPL", tone: "violet", title: "newService.template", description: "newService.templateHint" },
  { kind: "dockerHub", tag: "HUB", tone: "sky", title: "newService.dockerHub", description: "newService.dockerHubHint" },
  { kind: "box", tag: "BOX", tone: "amber", title: "newService.box", description: "newService.boxHint" },
  { kind: "cron", tag: "CRON", tone: "gray", title: "newService.cron", description: "newService.cronHint" },
  { kind: "import", tag: "ZIP", tone: "gray", title: "newService.import", description: "newService.importHint" },
];

/** The mono kind tag used in menus and lists ("APP", "PG"). */
export function KindBadge({ tag, tone, className }: { tag: string; tone: NonNullable<ChipProps["tone"]>; className?: string }) {
  return (
    <Chip
      tone={tone}
      mono
      aria-hidden="true"
      className={`h-[26px] w-9 shrink-0 justify-center px-0 py-0 text-[10.5px] font-semibold ${className ?? ""}`}
    >
      {tag}
    </Chip>
  );
}

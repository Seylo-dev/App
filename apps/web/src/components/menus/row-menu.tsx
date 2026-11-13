// The app's right-click menu for a row or card: the kit's RowContextMenu
// with the drag rules of sortable.tsx. No menu opens while a row is
// dragged, and a menu that opens while a drag waits for its first 6 px (a
// touch long-press, a Control-click on a Mac) drops that drag, so moving
// over the open menu does not lift the row under it. Also the copy items'
// one way to copy and say so.

import { copyText } from "@seylo/ui/components/copy-field";
import { RowContextMenu } from "@seylo/ui/components/menu-items";
import { toast } from "@seylo/ui/components/toast";
import type { ComponentProps } from "react";
import { t } from "../../i18n/t";
import { cancelPendingDrag, isDragging } from "../sortable";

export function RowMenu(props: Omit<ComponentProps<typeof RowContextMenu>, "blocked" | "onOpenChange">) {
  return (
    <RowContextMenu
      {...props}
      blocked={isDragging}
      onOpenChange={(open) => {
        if (open) cancelPendingDrag();
      }}
    />
  );
}

/** Copies `text` and says so in a toast (with what was copied), or says it could not. */
export async function copyWithToast(text: string): Promise<void> {
  if (await copyText(text)) toast.success(t("menus.copied"), { description: text });
  else toast.error(t("menus.copyFailed"));
}

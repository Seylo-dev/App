// Drag to reorder, for the projects and services the sidebar, the dashboard
// and the project page list in the person's own order (lib/use-project-prefs.ts).
// A drag starts after the pointer moves 6 px, so a click still opens the
// link it lands on, and the click that ends a drag is swallowed. The
// keyboard works too: focus the item, Space to lift, the arrow keys to
// move, Space to drop, Escape to cancel.

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@seylo/ui/lib/utils";
import { IconGripVertical } from "@tabler/icons-react";
import { type CSSProperties, createContext, type ReactNode, useContext } from "react";
import { t } from "../i18n/t";

/**
 * Whether a drag is on, and when the last one ended: the click the browser fires right after must not open a link.
 * Never 0: performance.now() starts at 0 when the page loads, so the first 250 ms would count as right after a drop.
 */
let dragOn = false;
let lastDragEnd = Number.NEGATIVE_INFINITY;

/** The click a drop leaves behind: a pointer's click (detail 1 or more) within 250 ms of the drag ending. */
export function isDropClick(detail: number, now: number, dragEnd: number): boolean {
  return detail > 0 && now - dragEnd < 250;
}

// After a drop dnd-kit stops the click from propagating, so React (and the
// item's own handler) never sees it, but the browser would still follow the
// link under the pointer. These run before dnd-kit's own listeners: the
// pointerup that ends a drag is noted, and the click right after has its
// default cancelled. Only a pointer's click (detail 1 or more): Enter in a
// form fires a click on its submit button with detail 0, and that one must
// still submit.
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerup",
    () => {
      if (dragOn) lastDragEnd = performance.now();
    },
    true,
  );
  window.addEventListener(
    "click",
    (event) => {
      if (isDropClick(event.detail, performance.now(), lastDragEnd)) event.preventDefault();
    },
    true,
  );
}

/** Keeps a list's items moving up and down only. */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** Whether drag handles are on: false while a list is filtered or still loading. */
const Enabled = createContext(true);

export function SortableGroup({
  ids,
  onMove,
  layout = "list",
  disabled = false,
  children,
}: {
  ids: readonly string[];
  /** The whole new order, after a drop that changed it. */
  onMove: (ids: string[]) => void;
  /** "grid" for cards in rows and columns; "list" moves up and down only. */
  layout?: "list" | "grid";
  disabled?: boolean;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    dragOn = false;
    lastDragEnd = performance.now();
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onMove(arrayMove([...ids], from, to));
  };
  return (
    <Enabled.Provider value={!disabled}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={layout === "list" ? [verticalOnly] : undefined}
        onDragStart={() => {
          dragOn = true;
        }}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          dragOn = false;
          lastDragEnd = performance.now();
        }}
      >
        <SortableContext
          items={[...ids]}
          strategy={layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy}
          disabled={disabled}
        >
          {children}
        </SortableContext>
      </DndContext>
    </Enabled.Provider>
  );
}

/**
 * One item of a SortableGroup. `handle` goes on the part a pointer drags
 * (the whole row or card, or only a header when the item holds a list of
 * its own); `grip` on a SortableGrip, the item's keyboard handle, so the row
 * itself does not become one big button around its own links and buttons.
 */
export function useSortableItem(id: string) {
  const enabled = useContext(Enabled);
  const sortable = useSortable({ id, disabled: !enabled });
  const { onKeyDown, onPointerDown } = (sortable.listeners ?? {}) as {
    onKeyDown?: (event: React.KeyboardEvent) => void;
    onPointerDown?: (event: React.PointerEvent) => void;
  };
  const style: CSSProperties = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
    ...(sortable.isDragging ? { position: "relative", zIndex: 20 } : {}),
  };
  return {
    ref: sortable.setNodeRef,
    style,
    dragging: sortable.isDragging,
    enabled,
    handle: {
      ...(enabled && onPointerDown ? { onPointerDown } : {}),
      // The click a drop leaves behind does not open the link under the pointer.
      onClickCapture: (event: React.MouseEvent) => {
        if (performance.now() - lastDragEnd < 250) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
    grip: {
      ref: sortable.setActivatorNodeRef,
      ...sortable.attributes,
      ...(enabled && onKeyDown ? { onKeyDown } : {}),
    },
  };
}

/**
 * An item's keyboard handle: hidden until it has keyboard focus (Tab
 * reaches it before the row's own controls), then Space lifts the item.
 */
export function SortableGrip({
  grip,
  name,
  className,
}: {
  grip: ReturnType<typeof useSortableItem>["grip"];
  name: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      {...grip}
      aria-label={t("common.move", { name })}
      className={cn(
        "sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-1/2 focus-visible:left-0 focus-visible:z-10 focus-visible:flex focus-visible:size-6 focus-visible:-translate-y-1/2 focus-visible:cursor-grab focus-visible:items-center focus-visible:justify-center focus-visible:rounded-chip focus-visible:border-0 focus-visible:bg-card focus-visible:text-foreground focus-visible:shadow-card focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      <IconGripVertical size={14} stroke={2} aria-hidden="true" />
    </button>
  );
}

/** The look of an item while it is lifted. */
export function draggingClass(dragging: boolean): string {
  return cn(dragging && "cursor-grabbing opacity-90 shadow-card");
}

/** A service card in its project's order; the whole card drags (a click still opens it). */
export function SortableCard({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const item = useSortableItem(id);
  return (
    <div
      ref={item.ref}
      style={item.style}
      {...item.handle}
      data-sortable-card=""
      className={cn("relative flex min-w-0 flex-col rounded-card [&>a]:flex-1", draggingClass(item.dragging))}
    >
      {item.enabled && <SortableGrip grip={item.grip} name={name} className="focus-visible:left-2" />}
      {children}
    </div>
  );
}

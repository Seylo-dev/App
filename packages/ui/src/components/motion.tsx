// Motion for the whole UI: one provider at the root, and the shared pieces
// screens animate with. Components use the m.* elements from "motion/react"
// (never motion.*): LazyMotion keeps the animation code out of the first
// bundle and loads it right after (lib/motion-features). MotionConfig with
// reducedMotion="user" turns movement off for people who ask their system
// for less motion.

import { LazyMotion, MotionConfig, m, type Transition, useReducedMotionConfig } from "motion/react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { cn } from "../lib/utils";

const loadFeatures = () => import("../lib/motion-features").then((mod) => mod.default);

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/** Counts indicator mounts: each mounted ActiveIndicator's layoutDependency. */
let indicatorMounts = 0;

/** How a selection background slides to the clicked item: quick, with no overshoot. */
export const slideTransition: Transition = { type: "spring", bounce: 0, visualDuration: 0.2 };

/**
 * The background (or underline) of the selected item in a nav, tab bar or
 * segmented control. Render it inside the selected item only; items that
 * share a `layoutId` form one group and the indicator slides between them.
 * Give every group its own id so groups never animate into each other. The
 * item needs `relative isolate` so the indicator sits behind its content.
 *
 * It slides only when the selection moves: the old item's indicator
 * unmounts and the new one mounts with the same layoutId. Each mounted
 * indicator has its own layoutDependency: without one, Motion measures it
 * on every re-render and animates any move of its box, so content loading
 * above a selection that stays (a card swapping its skeleton) drags the
 * pill off its item. It must differ between the old and the new indicator,
 * or Motion does not slide from one to the other (NodeStack.promote).
 */
export function ActiveIndicator({ layoutId, className }: { layoutId: string; className?: string }) {
  const [mounted] = useState(() => ++indicatorMounts);
  return (
    <m.span
      aria-hidden="true"
      data-slot="active-indicator"
      layoutId={layoutId}
      layoutDependency={mounted}
      transition={slideTransition}
      className={cn("pointer-events-none absolute inset-0 -z-10", className)}
    />
  );
}

/**
 * Content that fades in with a small rise whenever `motionKey` changes (a
 * new route, a new tab). Enter only: the old content is replaced at once, so
 * navigation never waits. The first render does not animate, and neither
 * does anything for people who ask for reduced motion.
 */
export function EnterOnChange({
  motionKey,
  subtle = false,
  className,
  children,
  ...rest
}: Pick<ComponentProps<"div">, "id" | "role" | "aria-label" | "aria-labelledby"> & {
  motionKey: string;
  /** A quieter version for tabs inside a page. */
  subtle?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotionConfig();
  // Derived state: the first key renders as is, every later key animates in.
  const [seen, setSeen] = useState({ key: motionKey, changed: false });
  if (seen.key !== motionKey) setSeen({ key: motionKey, changed: true });
  const enter = seen.changed && !reduced;
  return (
    <m.div
      key={motionKey}
      // From 40% opacity, not 0: the new page is readable on its first frame and still eases in.
      initial={enter ? { opacity: 0.4, y: subtle ? 3 : 5 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: subtle ? 0.14 : 0.16, ease: "easeOut" }}
      className={className}
      {...rest}
    >
      {children}
    </m.div>
  );
}

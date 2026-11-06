// How overlays open and close (tw-animate-css on Radix's data-state and
// data-side): a 200ms fade with a small scale, and menus, popovers and
// tooltips also move a few pixels away from their trigger. Each component
// adds its own transform origin so the scale starts at the trigger.

/** Menus, popovers and selects (data-state open or closed). */
export const popperMotion =
  "duration-200 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1";

/** Tooltips: Radix says delayed-open or instant-open instead of open. */
export const tooltipMotion =
  "duration-200 ease-out data-[state=delayed-open]:animate-in data-[state=instant-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=instant-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1";

/** The dimmed backdrop behind dialogs and sheets. */
export const overlayMotion =
  "duration-200 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

/** Centered dialogs: fade and a small scale. */
export const dialogMotion =
  "duration-200 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95";

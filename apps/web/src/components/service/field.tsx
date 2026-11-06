import { Checkbox } from "@seylo/ui/components/checkbox";
import { Label } from "@seylo/ui/components/input";
import { cn } from "@seylo/ui/lib/utils";
import type * as React from "react";
import { type ReactNode, useId } from "react";

/** A labelled form control with an optional hint below it. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <span className="text-xs leading-normal text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** A row with a switch or checkbox on the right and text on the left. */
export function ToggleRow({ title, description, control }: { title: ReactNode; description?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium">{title}</span>
        {description && <span className="text-[12.5px] leading-normal text-muted-foreground">{description}</span>}
      </div>
      <div className="flex shrink-0 items-center pt-0.5">{control}</div>
    </div>
  );
}

/** Parses an integer field; empty gives null. */
export function parseIntOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

/** A checkbox with its label, tied together by id so screen readers and clicks on the text work. */
export function CheckLabel({ className, children, ...props }: React.ComponentProps<typeof Checkbox> & { children: ReactNode }) {
  const id = useId();
  return (
    <div className={cn("flex items-center gap-2 text-[13px]", className)}>
      <Checkbox id={id} {...props} />
      <label htmlFor={id}>{children}</label>
    </div>
  );
}

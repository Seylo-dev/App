import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-[7px] whitespace-nowrap rounded-control border-0 font-medium transition-interactive disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // hover-enabled (tailwind.css): disabled buttons never look hovered, and a caller's hover: class still wins.
        primary: "bg-primary text-primary-foreground shadow-primary hover-enabled:brightness-110",
        // The fill follows the surface (tailwind.css): white with a shadow on the page, a quiet gray on a card or dialog.
        secondary: "bg-button text-secondary-foreground shadow-button hover-enabled:bg-button-hover",
        ghost: "bg-transparent text-muted-foreground hover-enabled:bg-muted hover-enabled:text-foreground",
        destructive: "bg-destructive text-destructive-foreground hover-enabled:brightness-110",
        // Near black on light presets; on dark ones a raised fill, not a white slab louder than primary.
        dark: "bg-button-dark text-button-dark-foreground hover-enabled:opacity-90",
      },
      size: {
        default: "h-[38px] px-[15px] text-[13.5px]",
        sm: "h-8 px-3 text-[12.5px]",
        icon: "size-[30px] rounded-chip",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export interface ButtonProps extends React.ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Render the child element (for example a router Link) with button styles. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type = "button", ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp data-slot="button" type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

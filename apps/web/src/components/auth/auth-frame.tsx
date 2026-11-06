// The frame of the signed-out screens (sign-in, setup): the panel's mark
// and name on top, the content, and "Powered by" unless white-labelled.

import { displayName } from "@seylo/brand";
import { cn } from "@seylo/ui/lib/utils";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { useBoot } from "../../lib/theme";
import { BrandMark } from "../brand-mark";

export function AuthFrame({ children, className }: { children: ReactNode; className?: string }) {
  const boot = useBoot();
  const name = boot?.name ?? displayName;
  const showPoweredBy = boot ? !boot.hidePoweredBy && boot.name !== boot.productName : false;
  return (
    <main className={cn("flex min-h-dvh flex-col items-center gap-7 px-4 pt-14 pb-10", className)}>
      <div className="flex items-center gap-2.5">
        <BrandMark size={32} />
        <span className="text-lg font-semibold tracking-[-0.015em]">{name}</span>
      </div>
      {children}
      {showPoweredBy && boot && (
        <p className="m-0 mt-auto text-xs text-muted-foreground">{t("auth.poweredBy", { name: boot.productName })}</p>
      )}
    </main>
  );
}

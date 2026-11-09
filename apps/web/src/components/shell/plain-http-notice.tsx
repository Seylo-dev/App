// The app shell's notice while the panel is reached over plain HTTP on a
// network address (lib/plain-http.ts): one calm line, a link to set the
// panel domain (owners and admins, who can), and "More" for the SSH tunnel.
// Dismissed per browser. The sign-in and setup screens show nothing.

import { auth } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { cn } from "@seylo/ui/lib/utils";
import { IconInfoCircle, IconX } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { t } from "../../i18n/t";
import { dismissPlainHttpNotice, type PlainHttpPage, plainHttpNoticeDismissed, plainHttpPage } from "../../lib/plain-http";

export function PlainHttpNotice({ className }: { className?: string }) {
  const [dismissed, setDismissed] = useState(() => plainHttpNoticeDismissed());
  const me = useOp(auth.whoami, {});
  const page = plainHttpPage(window.location, window.isSecureContext);
  if (!page || dismissed) return null;
  const role = me.data?.viewer.role;
  return (
    <PlainHttpNoticeView
      page={page}
      canSetDomain={role === "owner" || role === "admin"}
      onDismiss={() => {
        dismissPlainHttpNotice();
        setDismissed(true);
      }}
      className={className}
    />
  );
}

export interface PlainHttpNoticeViewProps {
  page: PlainHttpPage;
  /** Owners and admins: settings.updateGeneral sets the panel domain. */
  canSetDomain: boolean;
  onDismiss: () => void;
  /** Start with the tunnel shown (tests). */
  defaultOpen?: boolean;
  className?: string;
}

export function PlainHttpNoticeView({ page, canSetDomain, onDismiss, defaultOpen = false, className }: PlainHttpNoticeViewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const tunnelId = useId();
  return (
    <div
      role="note"
      data-testid="plain-http-notice"
      className={cn("flex flex-col gap-2 rounded-card bg-card px-4 py-2 text-[13px] text-ink-strong shadow-card", className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 flex-1 basis-60 items-center gap-2.5 py-1">
          <IconInfoCircle size={16} stroke={1.9} className="shrink-0 text-ink-faint" />
          <span>{t("plainHttp.text")}</span>
        </span>
        <span className="-mr-2 ml-auto flex items-center gap-0.5">
          {canSetDomain && (
            <Button asChild size="sm" variant="ghost">
              <Link to="/settings/general">{t("plainHttp.setDomain")}</Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={tunnelId} onClick={() => setOpen((value) => !value)}>
            {open ? t("plainHttp.less") : t("plainHttp.more")}
          </Button>
          <Button size="icon" variant="ghost" aria-label={t("plainHttp.dismiss")} onClick={onDismiss}>
            <IconX size={15} stroke={1.9} />
          </Button>
        </span>
      </div>
      {open && (
        <div id={tunnelId} className="flex flex-col gap-2 pb-2 text-muted-foreground">
          <span>{t("plainHttp.tunnel")}</span>
          {/* 127.0.0.1, not localhost: with IP access off, Docker publishes the port on IPv4 loopback only. */}
          <CodeBlock code={`ssh -L ${page.port}:127.0.0.1:${page.port} root@${page.host}`} tone="dark" />
          <span>{t("plainHttp.thenOpen", { url: `http://127.0.0.1:${page.port}` })}</span>
        </div>
      )}
    </div>
  );
}

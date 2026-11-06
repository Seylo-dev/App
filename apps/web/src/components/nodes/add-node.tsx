// "Add a node" (Nodes.dc.html): a single-use join command to run on the
// new server, how long it stays valid, and the optional wildcard DNS
// record for automatic domains. A command is only created when someone
// asks for one (it is a credential); the token itself is never shown again
// after this card is gone.

import { nodes } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { CopyField } from "@seylo/ui/components/copy-field";
import { IconPlus } from "@tabler/icons-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { formatExpiresIn } from "../../lib/format";
import { isReauthCancelled } from "../../lib/reauth";
import { QueryError } from "../query-error";

export interface AddNodeHandle {
  /** Scrolls the card into view and creates a join command if there is none. */
  start(): void;
}

export const AddNodeCard = forwardRef<AddNodeHandle>(function AddNodeCard(_props, ref) {
  const section = useRef<HTMLElement>(null);
  const create = useOpMutation(nodes.createJoinToken);
  const open = useOp(nodes.listJoinTokens, {}, { retry: false });
  const [now, setNow] = useState(Date.now());
  const token = create.data;

  useImperativeHandle(ref, () => ({
    start() {
      section.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (!create.data && !create.isPending) create.mutate({});
    },
  }));

  // Tick the "expires in" text while a command is on screen.
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [token]);

  const expired = token ? Date.parse(token.expiresAt) <= now : false;
  const otherOpen = (open.data?.tokens ?? []).filter((item) => item.id !== token?.tokenId).length;

  return (
    <section
      ref={section}
      aria-label={t("nodes.addCard.title")}
      className="flex flex-col gap-3.5 rounded-card bg-card px-5 pt-[18px] pb-5 shadow-card"
    >
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("nodes.addCard.title")}</h2>
        <span className="text-[12.5px] text-muted-foreground">{t("nodes.addCard.subtitle")}</span>
      </div>
      <div className="flex flex-col gap-[7px]">
        <span className="text-[12.5px] font-medium text-ink-strong">{t("nodes.addCard.step1")}</span>
        {token && !expired ? (
          <>
            <CopyField value={token.command} tone="terminal" aria-label={t("nodes.addCard.command")} />
            <span className="text-xs text-muted-foreground">
              {t("nodes.addCard.singleUse", { expires: formatExpiresIn(token.expiresAt, now) })}
            </span>
            {token.insecureTransport && (
              <span role="alert" className="text-xs text-chip-amber-fg">
                {t("nodes.addCard.insecure")}
              </span>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="dark" disabled={create.isPending} onClick={() => create.mutate({})}>
              <IconPlus size={15} stroke={2.2} aria-hidden="true" />
              {expired ? t("nodes.addCard.newCommand") : t("nodes.addCard.createCommand")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("nodes.addCard.createHint")}</span>
          </div>
        )}
        {create.error && !isReauthCancelled(create.error) && <QueryError error={create.error} />}
        {otherOpen > 0 && <span className="text-xs text-muted-foreground">{t("nodes.addCard.otherOpen", { count: otherOpen })}</span>}
      </div>
      <div className="flex flex-col gap-[7px] border-t border-divider pt-3.5">
        <span className="text-[12.5px] font-medium text-ink-strong">{t("nodes.addCard.step2")}</span>
        <span className="text-[12.5px] leading-[1.7] text-ink-strong">
          {t("nodes.addCard.dnsBefore")}{" "}
          <span className="rounded-chip bg-muted px-[7px] py-0.5 font-mono text-xs text-foreground">{t("nodes.addCard.dnsRecord")}</span>{" "}
          {t("nodes.addCard.dnsAfter")}{" "}
          <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer" className="font-medium">
            {t("nodes.addCard.cloudflare")}
          </a>
        </span>
      </div>
    </section>
  );
});

// "Add a node" (Nodes.dc.html): a single-use join command to run on the
// new server, how long it stays valid, whether the node builds images,
// and the optional wildcard DNS record for automatic domains. A command
// is only created when someone asks for one (it is a credential); the
// token itself is never shown again after this card is gone.

import { nodes, system } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { CopyField } from "@seylo/ui/components/copy-field";
import { IconPlus } from "@tabler/icons-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { formatExpiresIn } from "../../lib/format";
import { joinInstallsDocker } from "../../lib/join-installer";
import { isReauthCancelled } from "../../lib/reauth";
import { QueryError } from "../query-error";

export interface AddNodeHandle {
  /** Scrolls the card into view and creates a join command if there is none. */
  start(): void;
}

export const AddNodeCard = forwardRef<AddNodeHandle>(function AddNodeCard(_props, ref) {
  const section = useRef<HTMLElement>(null);
  const create = useOpMutation(nodes.createJoinToken);
  const revoke = useOpMutation(nodes.revokeJoinToken);
  const open = useOp(nodes.listJoinTokens, {}, { retry: false });
  // Which installer the command runs depends on the panel's version (lib/join-installer.ts).
  const panelVersion = useOp(system.info, {}).data?.version;
  const [now, setNow] = useState(Date.now());
  // "Build images on this node": stored on the token, so the node that joins cannot change it.
  const [canBuild, setCanBuild] = useState(true);
  const token = create.data;

  useImperativeHandle(ref, () => ({
    start() {
      section.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (!create.data && !create.isPending) create.mutate({ canBuild });
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

  // The choice is part of the command: changing it revokes this one, so only one stays valid.
  const change = () => {
    if (!token) return;
    revoke.mutate(
      { tokenId: token.tokenId },
      {
        onSettled: () => {
          create.reset();
          void open.refetch();
        },
      },
    );
  };

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
            <span className="text-xs text-muted-foreground">
              {token.canBuild ? t("nodes.addCard.buildsOn") : t("nodes.addCard.buildsOff")}{" "}
              <button
                type="button"
                disabled={revoke.isPending}
                onClick={change}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-link disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("nodes.addCard.changeBuild")}
              </button>
            </span>
            {token.insecureTransport && (
              <span role="alert" className="text-xs text-chip-amber-fg">
                {t("nodes.addCard.insecure")}
              </span>
            )}
          </>
        ) : (
          <>
            <div className="flex max-w-[640px] items-start gap-2 py-0.5">
              <Checkbox
                id="add-node-build"
                aria-describedby="add-node-build-hint"
                className="mt-px"
                checked={canBuild}
                disabled={create.isPending}
                onCheckedChange={(value) => setCanBuild(value === true)}
              />
              <div className="flex flex-col gap-0.5">
                <label htmlFor="add-node-build" className="cursor-pointer text-[12.5px] leading-4 font-medium text-ink-strong">
                  {t("nodes.addCard.buildImages")}
                </label>
                <span id="add-node-build-hint" className="text-xs text-muted-foreground">
                  {t("nodes.addCard.buildImagesHint")}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="dark" disabled={create.isPending} onClick={() => create.mutate({ canBuild })}>
                <IconPlus size={15} stroke={2.2} aria-hidden="true" />
                {expired ? t("nodes.addCard.newCommand") : t("nodes.addCard.createCommand")}
              </Button>
              <span className="text-xs text-muted-foreground">{t("nodes.addCard.createHint")}</span>
            </div>
          </>
        )}
        {panelVersion !== undefined && (
          <span className="text-xs text-muted-foreground">
            {joinInstallsDocker(panelVersion) ? t("nodes.addCard.installsDocker") : t("nodes.addCard.installsDockerAsks")}
          </span>
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

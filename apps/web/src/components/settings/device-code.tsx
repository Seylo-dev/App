// The GitHub device flow on screen (like `gh auth login`): show the code,
// open github.com/login/device, and poll until the person approved it.
// Used to link a GitHub login (Security) and to connect the account that
// clones private repos (GitHub settings).

import { Button } from "@seylo/ui/components/button";
import { CopyField } from "@seylo/ui/components/copy-field";
import { IconExternalLink, IconLoader2 } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { t } from "../../i18n/t";

export type DevicePollResult = "pending" | "slowDown" | "done" | "expired" | "denied";

export interface DeviceCodeView {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
}

/**
 * Polls `poll` every intervalSeconds (5 s more after "slowDown") until it
 * returns a final state, then calls onFinish. Stops when unmounted.
 */
export function DeviceCodePanel({
  code,
  poll,
  onFinish,
  onCancel,
}: {
  code: DeviceCodeView;
  poll: () => Promise<DevicePollResult>;
  onFinish: (result: "done" | "expired" | "denied" | "error", error?: unknown) => void;
  onCancel: () => void;
}) {
  const pollRef = useRef(poll);
  const finishRef = useRef(onFinish);
  pollRef.current = poll;
  finishRef.current = onFinish;

  useEffect(() => {
    let stopped = false;
    let interval = Math.max(1, code.intervalSeconds) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      try {
        const result = await pollRef.current();
        if (stopped) return;
        if (result === "slowDown") interval += 5000;
        if (result === "pending" || result === "slowDown") {
          timer = setTimeout(tick, interval);
          return;
        }
        finishRef.current(result);
      } catch (error) {
        if (!stopped) finishRef.current("error", error);
      }
    };
    timer = setTimeout(tick, interval);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [code.intervalSeconds]);

  return (
    <div className="flex flex-col gap-3 rounded-control bg-raised p-4">
      <p className="m-0 text-[13px] text-ink-strong">{t("settingsSecurity.device.instructions")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <CopyField value={code.userCode} aria-label={t("settingsSecurity.device.code")} className="w-44 text-base tracking-widest" />
        <Button asChild variant="primary">
          <a href={code.verificationUri} target="_blank" rel="noreferrer">
            <IconExternalLink size={15} stroke={1.8} />
            {t("settingsSecurity.device.open")}
          </a>
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
      <span className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <IconLoader2 size={14} className="animate-spin" aria-hidden="true" />
        {t("settingsSecurity.device.waiting")}
      </span>
    </div>
  );
}

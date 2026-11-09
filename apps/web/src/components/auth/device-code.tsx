// The GitHub device flow card (Setup.dc.html, right side): the code to
// type on GitHub, a copy button, the link to github.com/login/device and a
// spinner while the panel polls. Used by sign-in and by first-run setup.

import { useCopy } from "@seylo/ui/components/copy-field";
import { IconArrowUpRight, IconCheck, IconCopy } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { t } from "../../i18n/t";

export interface DeviceCodeView {
  ticket: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
}

export type PollStatus = "pending" | "slowDown" | "expired" | "denied" | "done" | "noAccount";

/**
 * Polls `poll(ticket)` every intervalSeconds (plus 5 s after each
 * slowDown) until it returns something other than pending or slowDown,
 * then hands that to `onFinished`. Stops when the component unmounts.
 */
export function useDevicePolling<R extends { status: PollStatus; intervalSeconds: number }>(
  code: DeviceCodeView | null,
  poll: (ticket: string) => Promise<R>,
  onFinished: (result: R) => void,
  onError: (error: unknown) => void,
): void {
  const callbacks = useRef({ poll, onFinished, onError });
  callbacks.current = { poll, onFinished, onError };

  useEffect(() => {
    if (!code) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (seconds: number) => {
      timer = setTimeout(async () => {
        try {
          const result = await callbacks.current.poll(code.ticket);
          if (stopped) return;
          if (result.status === "pending") tick(result.intervalSeconds);
          else if (result.status === "slowDown") tick(result.intervalSeconds + 5);
          else callbacks.current.onFinished(result);
        } catch (error) {
          if (!stopped) callbacks.current.onError(error);
        }
      }, seconds * 1000);
    };
    tick(code.intervalSeconds);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [code]);
}

export function DeviceCodeCard({ code, waiting }: { code: DeviceCodeView; waiting: boolean }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-center gap-4 rounded-card px-4 py-6 bg-highlight">
        <span className="font-mono text-[30px] font-medium tracking-[0.18em] text-foreground">
          <span className="sr-only">{t("auth.github.code")} </span>
          {code.userCode}
        </span>
        <button
          type="button"
          aria-label={t("auth.github.copyCode")}
          onClick={() => void copy(code.userCode)}
          className="flex size-8 cursor-pointer items-center justify-center rounded-control border-0 bg-button text-ink-strong shadow-button transition-interactive hover:bg-button-hover"
        >
          {copied ? <IconCheck size={15} stroke={2} /> : <IconCopy size={15} stroke={1.8} />}
        </button>
      </div>
      <a
        href={code.verificationUri}
        target="_blank"
        rel="noreferrer"
        className="flex h-[38px] items-center justify-center gap-2 rounded-control bg-muted text-[13.5px] font-medium text-foreground hover:text-foreground"
      >
        {t("auth.github.open", { url: code.verificationUri.replace(/^https?:\/\//, "") })}
        <IconArrowUpRight size={13} stroke={2} aria-hidden="true" />
      </a>
      {waiting && (
        <div role="status" className="flex items-center gap-2.5 text-[13px] text-ink-strong">
          <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 9 9" className="stroke-primary" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          {t("auth.github.waiting")}
        </div>
      )}
    </div>
  );
}

/** The GitHub mark for "Continue with GitHub" buttons. */
export function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

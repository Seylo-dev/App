// The warning every page shows while the panel is reached over plain HTTP
// (lib/plain-http.ts): set a panel domain, or come in through an SSH tunnel.

import { Alert } from "@seylo/ui/components/alert";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { cn } from "@seylo/ui/lib/utils";
import { t } from "../../i18n/t";
import { plainHttpPage } from "../../lib/plain-http";

export function PlainHttpWarning({ className }: { className?: string }) {
  const page = plainHttpPage(window.location, window.isSecureContext);
  if (!page) return null;
  return (
    <Alert tone="warning" title={t("auth.plainHttp.title")} className={cn("w-full", className)} data-testid="plain-http-warning">
      <div className="flex flex-col gap-2">
        <span>{t("auth.plainHttp.body", { host: page.host })}</span>
        <CodeBlock code={`ssh -L ${page.port}:localhost:${page.port} ${page.host}`} tone="dark" wrap />
        <span>{t("auth.plainHttp.thenOpen", { url: `http://localhost:${page.port}` })}</span>
      </div>
    </Alert>
  );
}

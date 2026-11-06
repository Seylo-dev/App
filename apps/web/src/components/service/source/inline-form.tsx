// A Dockerfile typed in the panel, edited with Monaco and built with an
// empty context. Saving sets the source to "inline" and the builder to
// dockerfile with the text.

import { builds, services } from "@seylo/ops";
import { useOp, useOpClient } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { CodeEditor } from "../editor/code-editor";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

const starter = "FROM nginx:1.27-alpine\nCOPY <<EOF /usr/share/nginx/html/index.html\nHello\nEOF\n";

export function InlineForm({ service }: { service: ServiceDetail }) {
  const settings = useOp(builds.getSettings, { serviceId: service.id }, { retry: retryOp });
  if (settings.isPending) return <Skeleton className="h-80 w-full" />;
  if (settings.isError) return <OpErrorNote error={settings.error} />;
  return <InlineEditor service={service} initial={settings.data.settings.inlineDockerfile ?? starter} />;
}

function InlineEditor({ service, initial }: { service: ServiceDetail; initial: string }) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const client = useOpClient();
  const invalidate = useInvalidate();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await client.call(builds.updateSettings, { serviceId: service.id, builder: "dockerfile", inlineDockerfile: text });
      if (service.sourceConfig.type !== "inline")
        await client.call(services.setSource, { serviceId: service.id, source: { type: "inline" } });
      invalidate(services.get, builds.getSettings);
      toast.success(t("service.saved"));
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-control shadow-[inset_0_0_0_1px_var(--input)]">
        <CodeEditor
          value={text}
          language="dockerfile"
          onChange={setText}
          onSave={() => void save()}
          height={360}
          aria-label={t("serviceSource.inline.editor")}
        />
      </div>
      <p className="m-0 text-xs text-muted-foreground">{t("serviceSource.inline.hint")}</p>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => void save()} disabled={saving || !text.trim()}>
          {saving ? t("service.saving") : t("service.save")}
        </Button>
        <MutationError error={error} />
      </div>
    </div>
  );
}

// Shared environment of a project: variables every service can reference
// as ${{project.VAR}}. Plain .env text; the panel checks it on save and
// says which services still run with the old values.

import { env } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { ButtonSkeleton, LoadingRegion, Skeleton } from "@seylo/ui/components/skeleton";
import { Textarea } from "@seylo/ui/components/textarea";
import { toast } from "@seylo/ui/components/toast";
// The text box holds local edits only; with no edits it shows the saved text, so a save elsewhere shows up.
import { useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { QueryError } from "../query-error";

export function SharedEnv({ projectId }: { projectId: string }) {
  const current = useOp(env.getShared, { projectId });
  const [text, setText] = useState<string | null>(null);
  const save = useOpMutation(env.setShared, {
    onSuccess: (result) => {
      setText(null);
      void current.refetch();
      toast.success(
        result.affectedServiceIds.length > 0
          ? t("project.env.savedAffected", { count: result.affectedServiceIds.length })
          : t("project.env.saved"),
      );
    },
  });

  if (current.isError) return <QueryError error={current.error} onRetry={() => void current.refetch()} />;
  if (current.isPending) return <SharedEnvSkeleton />;
  const value = text ?? current.data.text;
  const dirty = text !== null && text !== current.data.text;
  const diagnostics = save.data?.diagnostics ?? [];

  return (
    <SectionCard
      title={t("project.env.title")}
      description={t("project.env.description")}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {save.error && <span className="text-[13px] text-destructive">{errorMessage(save.error, t("common.unknownError"))}</span>}
          <Button className="ml-auto" disabled={!dirty} onClick={() => setText(null)}>
            {t("common.discard")}
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate({ projectId, text: value, expectedUpdatedAt: current.data.updatedAt })}
          >
            {t("common.save")}
          </Button>
        </div>
      }
    >
      <Textarea
        mono
        aria-label={t("project.env.title")}
        value={value}
        onChange={(event) => setText(event.target.value)}
        rows={Math.min(24, Math.max(8, value.split("\n").length + 1))}
        spellCheck={false}
        placeholder={"SENTRY_DSN=https://...\nLOG_LEVEL=info"}
      />
      {diagnostics.length > 0 && (
        <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0 text-[12.5px]">
          {diagnostics.map((diagnostic) => (
            <li
              key={`${diagnostic.range.startLine}:${diagnostic.code}`}
              className={diagnostic.severity === "error" ? "text-destructive" : "text-ink-strong"}
            >
              {t("project.env.line", { line: diagnostic.range.startLine })} {diagnostic.message}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** The shared environment card while it loads: title, description, an eight-line editor and the save bar. */
export function SharedEnvSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")}>
      <SectionCardSkeleton
        titleWidth="w-40"
        description="w-[min(560px,100%)]"
        footer={
          <>
            <ButtonSkeleton className="ml-auto w-20" />
            <ButtonSkeleton className="w-16" />
          </>
        }
      >
        <Skeleton className="h-[184px]" />
      </SectionCardSkeleton>
    </LoadingRegion>
  );
}

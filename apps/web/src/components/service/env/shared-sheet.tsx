// The project's shared variables (${{project.NAME}}), edited in a sheet from
// the Environment tab. Shared variables cannot reference services, so the
// editor runs the analyzer with an empty context: syntax only.

import { analyzeEnv } from "@seylo/env-analyzer";
import { env, OpError } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { toast } from "@seylo/ui/components/toast";
import { useEffect, useMemo, useState } from "react";
import { t } from "../../../i18n/t";
import { EnvEditor } from "../editor/env-editor";
import { useInvalidate } from "../invalidate";
import { MutationError, OpView, retryOp } from "../op-state";

const sharedContext = { self: { serviceId: null, name: "project", nodes: [] }, targets: [] };

export function SharedVariablesSheet({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shared = useOp(env.getShared, { projectId }, { enabled: open, retry: retryOp });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[min(640px,100vw)] max-w-none sm:max-w-none">
        <SheetHeader>
          <SheetTitle>{t("serviceEnv.shared.title")}</SheetTitle>
          <SheetDescription>{t("serviceEnv.shared.body")}</SheetDescription>
        </SheetHeader>
        <OpView query={shared} className="mx-5 my-4">
          {(data) => (
            <SharedEditor projectId={projectId} initialText={data.text} updatedAt={data.updatedAt} onDone={() => onOpenChange(false)} />
          )}
        </OpView>
      </SheetContent>
    </Sheet>
  );
}

function SharedEditor({
  projectId,
  initialText,
  updatedAt,
  onDone,
}: {
  projectId: string;
  initialText: string;
  updatedAt: string | null;
  onDone: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [reveal, setReveal] = useState(false);
  const invalidate = useInvalidate();
  useEffect(() => setText(initialText), [initialText]);
  const analysis = useMemo(() => analyzeEnv(text, sharedContext), [text]);
  const save = useOpMutation(env.setShared, {
    onSuccess: (res) => {
      invalidate(env.getShared, env.get, env.references);
      toast.success(
        res.affectedServiceIds.length ? t("serviceEnv.shared.savedAffected", { count: res.affectedServiceIds.length }) : t("service.saved"),
      );
      onDone();
    },
  });
  const onSave = () => save.mutate({ projectId, text, expectedUpdatedAt: updatedAt });
  return (
    <>
      <SheetBody className="py-4">
        <div className="overflow-hidden rounded-card shadow-card">
          <EnvEditor
            text={text}
            onChange={setText}
            analysis={analysis}
            context={null}
            selfName="project"
            reveal={reveal}
            onSave={onSave}
            height={420}
          />
        </div>
        {save.error instanceof OpError && save.error.code === "CONFLICT" ? (
          <p role="alert" className="m-0 text-[13px] text-chip-red-fg">
            {t("serviceEnv.conflictBody")}
          </p>
        ) : (
          <MutationError error={save.error} />
        )}
      </SheetBody>
      <SheetFooter>
        <Button size="sm" onClick={() => setReveal((v) => !v)} aria-pressed={reveal}>
          {reveal ? t("serviceEnv.hideValues") : t("serviceEnv.showValues")}
        </Button>
        <Button variant="primary" size="sm" className="ml-auto" onClick={onSave} disabled={save.isPending || text === initialText}>
          {save.isPending ? t("service.saving") : t("service.save")}
        </Button>
      </SheetFooter>
    </>
  );
}

// The watch paths of a service (deploy on push only when a changed file
// matches) with a live tester: paste changed files and see, per file and
// for the push, what the panel would do. The tester runs the same matcher
// as the panel (@seylo/ops watch-paths), so the answer is the real one.

import { decideWatchFile, describeWatchPaths, matchWatchPaths, normalizeWatchPaths, services, watchPatternProblem } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Textarea } from "@seylo/ui/components/textarea";
import { toast } from "@seylo/ui/components/toast";
import { useMemo, useState } from "react";
import { t } from "../../../i18n/t";
import { Field } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError } from "../op-state";
import { CardSaveBar } from "../save-bar";
import type { ServiceDetail } from "../use-service";

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function WatchPathsCard({ service }: { service: ServiceDetail }) {
  const saved = service.watchPaths ?? [];
  const [text, setText] = useState(saved.join("\n"));
  const [sample, setSample] = useState("");
  const invalidate = useInvalidate();
  const save = useOpMutation(services.setWatchPaths, {
    onSuccess: (out) => {
      setText(out.watchPaths.join("\n"));
      invalidate(services.get);
      toast.success(t("serviceSource.watch.saved"));
    },
  });

  const patterns = useMemo(() => normalizeWatchPaths(text.split("\n")), [text]);
  const problems = patterns.map((p) => ({ pattern: p, problem: watchPatternProblem(p) })).filter((p) => p.problem);
  const files = lines(sample);
  const result = files.length > 0 ? matchWatchPaths(patterns, files) : null;
  const changed = patterns.join("\n") !== saved.join("\n");

  return (
    <SectionCard title={t("serviceSource.watch.title")} description={t("serviceSource.watch.description")}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("serviceSource.watch.patterns")} htmlFor="watch-patterns" hint={t("serviceSource.watch.skipMarkers")}>
          <Textarea
            id="watch-patterns"
            className="min-h-32 font-mono text-[12.5px]"
            value={text}
            spellCheck={false}
            placeholder={t("serviceSource.watch.placeholder")}
            onChange={(e) => setText(e.target.value)}
          />
          {problems.map((p) => (
            <span key={p.pattern} role="alert" className="text-xs text-chip-red-fg">
              {p.pattern}: {p.problem}
            </span>
          ))}
        </Field>
        <Field label={t("serviceSource.watch.tester")} htmlFor="watch-sample" hint={t("serviceSource.watch.testerHint")}>
          <Textarea
            id="watch-sample"
            className="min-h-32 font-mono text-[12.5px]"
            value={sample}
            spellCheck={false}
            placeholder={t("serviceSource.watch.testerPlaceholder")}
            onChange={(e) => setSample(e.target.value)}
          />
        </Field>
      </div>
      {result && (
        <div className="flex flex-col gap-1.5" aria-live="polite" data-testid="watch-result">
          <div className="flex items-center gap-2 text-[13px]">
            <Chip tone={result.deploy ? "green" : "gray"}>
              {result.deploy ? t("serviceSource.watch.wouldDeploy") : t("serviceSource.watch.wouldSkip")}
            </Chip>
            <span className="text-muted-foreground">
              {patterns.length === 0 ? t("serviceSource.watch.off") : describeWatchPaths(result)}
            </span>
          </div>
          {patterns.length > 0 && (
            <ul className="m-0 flex list-none flex-col p-0">
              {files.map((file) => {
                const d = decideWatchFile(patterns, file);
                const why = d.included
                  ? d.pattern
                    ? t("serviceSource.watch.matches", { pattern: d.pattern })
                    : t("serviceSource.watch.notExcluded")
                  : d.pattern
                    ? t("serviceSource.watch.excludedBy", { pattern: d.pattern })
                    : t("serviceSource.watch.noPattern");
                return (
                  <li key={file} className="flex flex-wrap items-center gap-2 border-t border-divider py-1.5 text-[12.5px]">
                    <span className={d.included ? "size-1.5 rounded-full bg-chip-green-fg" : "size-1.5 rounded-full bg-ink-faint"} />
                    <span className="min-w-0 truncate font-mono">{d.file}</span>
                    <span className="text-muted-foreground">{why}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <p className="m-0 text-xs text-muted-foreground">{t("serviceSource.watch.unknownFiles")}</p>
      <CardSaveBar>
        <Button
          size="sm"
          variant="primary"
          disabled={!changed || problems.length > 0 || save.isPending}
          onClick={() => save.mutate({ serviceId: service.id, watchPaths: patterns })}
        >
          {t("serviceSource.watch.save")}
        </Button>
        <MutationError error={save.error} />
      </CardSaveBar>
    </SectionCard>
  );
}

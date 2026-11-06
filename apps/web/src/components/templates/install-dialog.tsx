// Installing a template (Templates.dc.html): the template's form (built
// from its fields), the project and node, and a live "This creates" list
// from templates.preview, which runs the template in the sandbox without
// creating anything. Conflicts and warnings show before Install.

import { templates } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { IconShieldCheck, IconX } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { kindTag } from "../../lib/service-display";
import type { FormField, FormValue, TemplateDetail, TemplateSummary } from "../../lib/types";
import { KindBadge } from "../new-service/kinds";
import { NodePicker, ProjectPicker } from "../pickers";
import { QueryError } from "../query-error";
import { TemplateLogo } from "./template-logo";

const namePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function InstallDialog({
  template,
  projectId,
  onClose,
}: {
  template: TemplateSummary | null;
  projectId?: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={template !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="top-[6%] max-h-[88dvh] max-w-[760px] overflow-y-auto p-0">
        {template && <InstallForm key={template.slug} summary={template} fixedProjectId={projectId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function initialValues(fields: readonly FormField[]): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    if (field.default !== null) values[field.key] = field.default;
    else if (field.type === "boolean") values[field.key] = false;
    else if (field.type === "select" && field.options[0]) values[field.key] = field.options[0].value;
  }
  return values;
}

function InstallForm({ summary, fixedProjectId, onClose }: { summary: TemplateSummary; fixedProjectId?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const detail = useOp(templates.get, { slug: summary.slug });
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState(summary.slug.slice(0, 40));
  const [values, setValues] = useState<Record<string, FormValue> | null>(null);
  const preview = useOpMutation(templates.preview);
  const install = useOpMutation(templates.create, {
    onSuccess: (result) => {
      toast.success(t("templates.installed", { name: summary.name }));
      onClose();
      const first = result.services[0];
      if (first) void navigate({ to: "/p/$projectId", params: { projectId: first.projectId } });
    },
  });

  const fields = detail.data?.fields ?? [];
  const current = values ?? (detail.data ? initialValues(detail.data.fields) : {});
  const nameValid = namePattern.test(name);
  const missing = fields.some(
    (field) => field.required && field.type !== "password" && field.type !== "domain" && (current[field.key] ?? "") === "",
  );
  const ready = detail.isSuccess && nameValid && projectId !== "" && nodeId !== "" && !missing;
  const conflict = preview.data?.services.some((service) => service.conflict) ?? false;

  // Preview again shortly after the form stops changing.
  const previewKey = JSON.stringify([projectId, nodeId, name, current]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewKey captures every input of the preview
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => preview.mutate({ projectId, slug: summary.slug, name, nodeId, values: current }), 400);
    return () => clearTimeout(timer);
  }, [previewKey, ready]);

  const setValue = (key: string, value: FormValue) => setValues({ ...current, [key]: value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    install.mutate({ projectId, slug: summary.slug, name, nodeId, values: current });
  };

  return (
    <form onSubmit={submit} className="flex flex-col">
      <div className="flex items-center gap-3 border-b border-divider px-[22px] py-[18px]">
        <TemplateLogo slug={summary.slug} name={summary.name} logoUrl={summary.logoUrl} size={38} />
        <span className="flex min-w-0 flex-col gap-px">
          <DialogTitle className="text-base">{t("templates.install", { name: summary.name })}</DialogTitle>
          <DialogDescription className="text-[12.5px]">{summary.creates}</DialogDescription>
        </span>
        <DialogClose asChild>
          <Button size="icon" className="ml-auto size-8 rounded-control bg-muted shadow-none" aria-label={t("common.close")}>
            <IconX size={15} stroke={2} />
          </Button>
        </DialogClose>
      </div>

      <div className="grid grid-cols-1 gap-[22px] px-[22px] py-5 md:grid-cols-2">
        <div className="flex flex-col gap-[13px]">
          {!fixedProjectId && (
            <Labeled id="tpl-project" label={t("newService.project")}>
              <ProjectPicker id="tpl-project" value={projectId} onChange={setProjectId} />
            </Labeled>
          )}
          <Labeled
            id="tpl-name"
            label={t("templates.serviceName")}
            hint={name !== "" && !nameValid ? t("newService.nameInvalid") : undefined}
          >
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              maxLength={40}
              required
              className="font-mono"
            />
          </Labeled>
          <Labeled id="tpl-node" label={t("newService.node")}>
            <NodePicker id="tpl-node" value={nodeId} onChange={setNodeId} />
          </Labeled>
          {detail.isPending && <Skeleton className="h-24" />}
          {detail.isError && <QueryError error={detail.error} onRetry={() => void detail.refetch()} />}
          {fields.map((field) => (
            <FieldInput key={field.key} field={field} value={current[field.key]} onChange={(value) => setValue(field.key, value)} />
          ))}
        </div>

        <div className="flex flex-col gap-3.5 text-[13px] leading-normal text-ink-strong">
          <p className="m-0 whitespace-pre-line">{detail.data?.body || summary.description}</p>
          <Preview detail={detail.data} preview={preview} />
          {detail.data && detail.data.links.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {detail.data.links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-[7px] bg-muted px-2.5 py-[5px] text-[12.5px] font-medium"
                >
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 rounded-b-card border-t border-divider bg-raised px-[22px] py-3.5">
        <span className="flex items-center gap-[7px] text-xs text-muted-foreground">
          <IconShieldCheck size={14} stroke={2} className="text-chip-green-fg" aria-hidden="true" />
          {t("templates.sandboxed")}
        </span>
        {install.error && <span className="text-[12.5px] text-destructive">{errorMessage(install.error, t("common.unknownError"))}</span>}
        <Button className="ml-auto" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || conflict || install.isPending}>
          {install.isPending ? t("templates.installing") : t("templates.install", { name: summary.name })}
        </Button>
      </div>
    </form>
  );
}

function Preview({
  detail,
  preview,
}: {
  detail: TemplateDetail | undefined;
  preview: ReturnType<typeof useOpMutation<typeof templates.preview>>;
}) {
  return (
    <div className="flex flex-col gap-[9px] rounded-card px-4 py-3.5" style={{ background: "var(--highlight)" }}>
      <b className="font-semibold text-foreground">{t("newService.thisCreates")}</b>
      {preview.isError && <QueryError error={preview.error} />}
      {!preview.data && !preview.isError && (
        <span className="text-[12.5px] text-muted-foreground">{detail ? t("templates.previewPending") : t("common.loading")}</span>
      )}
      {preview.data?.services.map((service) => {
        const tag = kindTag({ kind: service.kind, templateSlug: null, protected: false });
        const parts = [service.name, service.image];
        if (service.ports[0]) parts.push(t("templates.port", { port: service.ports[0] }));
        if (service.internalOnly) parts.push(t("project.internalOnly"));
        else if (service.domains[0]) parts.push(service.domains[0]);
        return (
          <span key={service.name} className="flex items-center gap-[9px] text-foreground">
            <KindBadge tag={tag.label} tone={tag.tone} className="h-[22px] w-[34px] bg-card" />
            <span className="min-w-0 truncate">{parts.join(t("format.separator"))}</span>
            {service.conflict && <span className="ml-auto shrink-0 text-xs font-medium text-destructive">{t("templates.conflict")}</span>}
          </span>
        );
      })}
      {preview.data?.warnings.map((warning) => (
        <span key={warning} className="text-xs text-chip-amber-fg">
          {warning}
        </span>
      ))}
      <span className="text-xs text-ink-strong">{t("templates.secretsGenerated")}</span>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: FormField; value: FormValue | undefined; onChange: (value: FormValue) => void }) {
  const id = `tpl-field-${field.key}`;
  if (field.type === "boolean") {
    return (
      <label htmlFor={id} className="flex items-start gap-2.5 text-[13px]">
        <Checkbox id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} className="mt-0.5" />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{field.label}</span>
          {field.description && <span className="text-xs text-muted-foreground">{field.description}</span>}
        </span>
      </label>
    );
  }
  const hint =
    field.description ??
    (field.type === "password" ? t("templates.passwordHint") : field.type === "domain" ? t("templates.domainHint") : undefined);
  return (
    <Labeled id={id} label={field.required ? field.label : t("templates.optional", { label: field.label })} hint={hint ?? undefined}>
      {field.type === "select" ? (
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
          autoComplete={field.type === "password" ? "new-password" : "off"}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(field.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
          placeholder={field.type === "domain" ? t("templates.automatic") : undefined}
          className={field.type === "domain" ? "font-mono" : undefined}
        />
      )}
    </Labeled>
  );
}

function Labeled({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

// Dialogs of the Domains card: add a domain, change its routing, its access
// rules (basic auth, IP allowlist, rate limit, redirects) and upload a
// custom certificate (where a Let's Encrypt certificate that is not there
// yet can also be regenerated).

import { domains, type OpInput } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@seylo/ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { Switch } from "@seylo/ui/components/switch";
import { Textarea } from "@seylo/ui/components/textarea";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconCheck, IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import { t } from "../../../i18n/t";
import { CheckLabel, Field, parseIntOrNull, ToggleRow } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError } from "../op-state";
import { servicePort } from "../service-port";
import type { ServiceDetail } from "../use-service";
import { canRegenerate, LetsEncryptState } from "./certificate-state";
import type { Domain } from "./domain-row";

type HttpsMode = Domain["https"];

function DialogFrame({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  busy,
  submitLabel,
  error,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  onSubmit: () => void;
  busy: boolean;
  submitLabel: string;
  error: unknown;
  wide?: boolean;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={wide ? "top-[10%] max-w-2xl" : "top-[12%] max-w-lg"}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </div>
          {children}
          <MutationError error={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PortSelect({
  service,
  value,
  onChange,
  id,
  placeholder,
}: {
  service: ServiceDetail;
  value: number | null;
  onChange: (port: number | null) => void;
  id: string;
  /** What an empty field means: the service's port in Add domain, the domain's current one in Routing. */
  placeholder: number;
}) {
  // Any port can be typed (an app may listen on one it does not declare); the service's own ports are offered.
  const ports = service.ports.filter((p) => p.protocol === "tcp").map((p) => p.containerPort);
  const [open, setOpen] = useState(false);
  const current = value ?? placeholder;
  return (
    <Popover open={open && ports.length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            id={id}
            inputMode="numeric"
            autoComplete="off"
            className={cn("font-mono", ports.length > 0 && "pr-9")}
            value={value === null ? "" : String(value)}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 5);
              onChange(digits === "" ? null : Number(digits));
            }}
            placeholder={String(placeholder)}
          />
          {ports.length > 0 && (
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("serviceDomains.form.portSuggestions")}
                className="absolute top-1/2 right-[3px] flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-muted-foreground transition-interactive duration-200 hover:bg-muted hover:text-foreground"
              >
                <IconChevronDown size={14} stroke={2} aria-hidden="true" />
              </button>
            </PopoverTrigger>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" collisionPadding={16} className="w-44 p-1.5">
        <div role="listbox" aria-label={t("serviceDomains.form.port")} onKeyDown={moveInList}>
          {ports.map((p) => (
            <button
              key={p}
              type="button"
              role="option"
              aria-selected={p === current}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-2.5 py-2 text-left transition-interactive duration-200 hover:bg-accent focus-visible:bg-accent",
                p === current && "bg-accent",
              )}
            >
              <span className="font-mono text-[12.5px] text-foreground">{p}</span>
              {p === current && <IconCheck size={15} stroke={2} className="ml-auto shrink-0 text-primary" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Arrow keys, Home and End move between a list's options. */
function moveInList(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? Math.min(at + 1, items.length - 1)
          : Math.max(at - 1, 0);
  items[next]?.focus();
}

function HttpsSelect({ value, onChange }: { value: HttpsMode; onChange: (v: HttpsMode) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as HttpsMode)}>
      <SelectTrigger aria-label={t("serviceDomains.form.https")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(["acme", "custom", "off"] as const).map((m) => (
          <SelectItem key={m} value={m}>
            {t(`serviceDomains.https.${m}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const hostPattern = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export function AddDomainDialog({
  service,
  open,
  onOpenChange,
  becomesPrimary = false,
}: {
  service: ServiceDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** No domain of the service is primary yet: the panel makes this one primary, so the box is ticked and locked. */
  becomesPrimary?: boolean;
}) {
  const [host, setHost] = useState("");
  const [pathPrefix, setPath] = useState("/");
  const [stripPrefix, setStrip] = useState(false);
  const [port, setPort] = useState<number | null>(service.ports[0]?.containerPort ?? null);
  const [https, setHttps] = useState<HttpsMode>("acme");
  const [primary, setPrimary] = useState(false);
  const [redirect, setRedirect] = useState(false);
  const [forwardUrl, setForwardUrl] = useState("");
  const invalidate = useInvalidate();
  const add = useOpMutation(domains.add, {
    onSuccess: (res) => {
      invalidate(domains.list);
      toast.success(res.dns.status === "ok" ? t("serviceDomains.addedLive") : t("serviceDomains.addedWaiting"));
      onOpenChange(false);
      setHost("");
    },
  });
  const cleanHost = host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return (
    <DialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title={t("serviceDomains.addTitle")}
      description={t("serviceDomains.addBody")}
      busy={add.isPending || !hostPattern.test(cleanHost)}
      submitLabel={t("serviceDomains.add")}
      error={add.error}
      onSubmit={() =>
        add.mutate({
          serviceId: service.id,
          host: cleanHost,
          pathPrefix,
          stripPrefix,
          https,
          primary: primary || becomesPrimary,
          // Empty: the service's port (servicePort), which for a portless app built from a repository is its PORT.
          targetPort: port || servicePort(service),
          ...(redirect && forwardUrl ? { forward: { url: forwardUrl, permanent: true, keepPath: true } } : {}),
        })
      }
    >
      <Field label={t("serviceDomains.form.host")} htmlFor="d-host">
        <Input
          id="d-host"
          className="font-mono"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="shop.example.com"
          autoFocus
        />
      </Field>
      <ToggleRow
        title={t("serviceDomains.form.redirectOnly")}
        description={t("serviceDomains.form.redirectOnlyHint")}
        control={<Switch checked={redirect} onCheckedChange={setRedirect} aria-label={t("serviceDomains.form.redirectOnly")} />}
      />
      {redirect ? (
        <Field label={t("serviceDomains.form.forwardUrl")} htmlFor="d-fwd">
          <Input
            id="d-fwd"
            className="font-mono"
            value={forwardUrl}
            onChange={(e) => setForwardUrl(e.target.value)}
            placeholder="https://example.com"
          />
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("serviceDomains.form.path")} htmlFor="d-path" hint={t("serviceDomains.form.pathHint")}>
            <Input id="d-path" className="font-mono" value={pathPrefix} onChange={(e) => setPath(e.target.value || "/")} />
          </Field>
          <Field label={t("serviceDomains.form.port")} htmlFor="d-port">
            <PortSelect id="d-port" service={service} value={port} onChange={setPort} placeholder={servicePort(service)} />
          </Field>
          <Field label={t("serviceDomains.form.https")}>
            <HttpsSelect value={https} onChange={setHttps} />
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-1 text-[13px]">
            <CheckLabel
              className="flex items-center gap-2"
              checked={stripPrefix}
              onCheckedChange={(v) => setStrip(v === true)}
              disabled={pathPrefix === "/"}
            >
              {t("serviceDomains.form.strip")}
            </CheckLabel>
            <CheckLabel
              className="flex items-center gap-2"
              checked={primary || becomesPrimary}
              onCheckedChange={(v) => setPrimary(v === true)}
              disabled={becomesPrimary}
            >
              {t("serviceDomains.form.makePrimary")}
            </CheckLabel>
          </div>
        </div>
      )}
    </DialogFrame>
  );
}

export function RoutingDialog({
  service,
  domain,
  onOpenChange,
}: {
  service: ServiceDetail;
  domain: Domain;
  onOpenChange: (open: boolean) => void;
}) {
  const [pathPrefix, setPath] = useState(domain.pathPrefix);
  const [stripPrefix, setStrip] = useState(domain.stripPrefix);
  const [port, setPort] = useState<number | null>(domain.targetPort);
  const [https, setHttps] = useState<HttpsMode>(domain.https);
  const [redirectToHttps, setRedirectToHttps] = useState(domain.redirectToHttps);
  const [forward, setForward] = useState(domain.forward);
  const invalidate = useInvalidate();
  const update = useOpMutation(domains.update, {
    onSuccess: () => {
      invalidate(domains.list);
      toast.success(t("service.saved"));
      onOpenChange(false);
    },
  });
  return (
    <DialogFrame
      open
      onOpenChange={onOpenChange}
      title={t("serviceDomains.routingTitle", { host: domain.host })}
      busy={update.isPending}
      submitLabel={t("service.save")}
      error={update.error}
      onSubmit={() =>
        update.mutate({
          serviceId: service.id,
          domainId: domain.id,
          pathPrefix,
          stripPrefix,
          https,
          redirectToHttps,
          forward,
          ...(port ? { targetPort: port } : {}),
        })
      }
    >
      {forward ? (
        <>
          <Field label={t("serviceDomains.form.forwardUrl")} htmlFor="r-fwd">
            <Input id="r-fwd" className="font-mono" value={forward.url} onChange={(e) => setForward({ ...forward, url: e.target.value })} />
          </Field>
          <CheckLabel
            className="flex items-center gap-2 text-[13px]"
            checked={forward.permanent}
            onCheckedChange={(v) => setForward({ ...forward, permanent: v === true })}
          >
            {t("serviceDomains.form.permanent")}
          </CheckLabel>
          <CheckLabel
            className="flex items-center gap-2 text-[13px]"
            checked={forward.keepPath}
            onCheckedChange={(v) => setForward({ ...forward, keepPath: v === true })}
          >
            {t("serviceDomains.form.keepPath")}
          </CheckLabel>
          <Button size="sm" className="self-start" onClick={() => setForward(null)}>
            {t("serviceDomains.form.routeInstead")}
          </Button>
        </>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("serviceDomains.form.path")} htmlFor="r-path" hint={t("serviceDomains.form.pathHint")}>
            <Input id="r-path" className="font-mono" value={pathPrefix} onChange={(e) => setPath(e.target.value || "/")} />
          </Field>
          <Field label={t("serviceDomains.form.port")} htmlFor="r-port">
            {/* Empty keeps the domain's port, which the placeholder shows. */}
            <PortSelect id="r-port" service={service} value={port} onChange={setPort} placeholder={domain.targetPort} />
          </Field>
          <Field label={t("serviceDomains.form.https")}>
            <HttpsSelect value={https} onChange={setHttps} />
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-1 text-[13px]">
            <CheckLabel
              className="flex items-center gap-2"
              checked={stripPrefix}
              onCheckedChange={(v) => setStrip(v === true)}
              disabled={pathPrefix === "/"}
            >
              {t("serviceDomains.form.strip")}
            </CheckLabel>
            <CheckLabel
              className="flex items-center gap-2"
              checked={redirectToHttps}
              onCheckedChange={(v) => setRedirectToHttps(v === true)}
              disabled={https === "off"}
            >
              {t("serviceDomains.form.redirectToHttps")}
            </CheckLabel>
          </div>
        </div>
      )}
    </DialogFrame>
  );
}

export function CertificateDialog({
  serviceId,
  domain,
  onOpenChange,
}: {
  serviceId: string;
  domain: Domain;
  onOpenChange: (open: boolean) => void;
}) {
  const [certPem, setCert] = useState("");
  const [privateKey, setKey] = useState("");
  const invalidate = useInvalidate();
  const save = useOpMutation(domains.setCertificate, {
    onSuccess: () => {
      invalidate(domains.list);
      toast.success(t("service.saved"));
      onOpenChange(false);
    },
  });
  return (
    <DialogFrame
      open
      wide
      onOpenChange={onOpenChange}
      title={t("serviceDomains.certTitle", { host: domain.host })}
      description={t("serviceDomains.certBody")}
      busy={save.isPending || certPem.length < 100 || privateKey.length < 100}
      submitLabel={t("service.save")}
      error={save.error}
      onSubmit={() => save.mutate({ serviceId, domainId: domain.id, certPem, privateKey })}
    >
      {canRegenerate(domain) && <LetsEncryptState serviceId={serviceId} domain={domain} />}
      <Field label={t("serviceDomains.form.certPem")} htmlFor="c-cert">
        <Textarea
          id="c-cert"
          mono
          rows={6}
          value={certPem}
          onChange={(e) => setCert(e.target.value)}
          placeholder="-----BEGIN CERTIFICATE-----"
        />
      </Field>
      <Field label={t("serviceDomains.form.privateKey")} htmlFor="c-key">
        <Textarea
          id="c-key"
          mono
          rows={6}
          value={privateKey}
          onChange={(e) => setKey(e.target.value)}
          placeholder="-----BEGIN PRIVATE KEY-----"
        />
      </Field>
    </DialogFrame>
  );
}

type MiddlewareInput = OpInput<typeof domains.setMiddlewares>;
type Redirect = Domain["middlewares"]["redirects"][number];

/** Basic auth, IP allowlist, rate limit and redirects for one domain, in a sheet. */
export function AccessRulesSheet({
  serviceId,
  domain,
  onOpenChange,
}: {
  serviceId: string;
  domain: Domain;
  onOpenChange: (open: boolean) => void;
}) {
  const mw = domain.middlewares;
  const [authOn, setAuthOn] = useState(mw.basicAuth !== null);
  const [users, setUsers] = useState<{ username: string; password: string; existing: boolean }[]>(
    (mw.basicAuth?.usernames ?? []).map((username) => ({ username, password: "", existing: true })),
  );
  const [allow, setAllow] = useState(mw.ipAllowList.join("\n"));
  const [limitOn, setLimitOn] = useState(mw.rateLimit !== null);
  const [average, setAverage] = useState(String(mw.rateLimit?.average ?? 100));
  const [burst, setBurst] = useState(String(mw.rateLimit?.burst ?? 200));
  const [period, setPeriod] = useState(String(mw.rateLimit?.periodSeconds ?? 1));
  const [redirects, setRedirects] = useState<Redirect[]>(mw.redirects);
  const invalidate = useInvalidate();
  const save = useOpMutation(domains.setMiddlewares, {
    onSuccess: () => {
      invalidate(domains.list);
      toast.success(t("service.saved"));
      onOpenChange(false);
    },
  });

  const submit = () => {
    const input: MiddlewareInput = {
      serviceId,
      domainId: domain.id,
      basicAuth: authOn
        ? {
            users: users
              .filter((u) => u.username.trim())
              .map((u) => ({ username: u.username.trim(), ...(u.password ? { password: u.password } : {}) })),
          }
        : null,
      ipAllowList: allow
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      rateLimit: limitOn
        ? { average: parseIntOrNull(average) ?? 100, burst: parseIntOrNull(burst) ?? 200, periodSeconds: parseIntOrNull(period) ?? 1 }
        : null,
      redirects: redirects.filter((r) => r.from && r.to),
    };
    save.mutate(input);
  };

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="w-[min(560px,100vw)] max-w-none sm:max-w-none">
        <SheetHeader>
          <SheetTitle>{t("serviceDomains.accessTitle")}</SheetTitle>
          <SheetDescription className="font-mono">{domain.host}</SheetDescription>
        </SheetHeader>
        <SheetBody className="gap-5 py-4">
          <section className="flex flex-col gap-3">
            <ToggleRow
              title={t("serviceDomains.access.basicAuth")}
              description={t("serviceDomains.access.basicAuthHint")}
              control={<Switch checked={authOn} onCheckedChange={setAuthOn} aria-label={t("serviceDomains.access.basicAuth")} />}
            />
            {authOn && (
              <div className="flex flex-col gap-2">
                {users.map((u, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: unsaved form rows have no id
                  <div key={`${i}-${u.existing}`} className="flex gap-2">
                    <Input
                      aria-label={t("serviceDomains.access.username")}
                      placeholder={t("serviceDomains.access.username")}
                      value={u.username}
                      onChange={(e) => setUsers(users.map((x, j) => (j === i ? { ...x, username: e.target.value } : x)))}
                    />
                    <Input
                      type="password"
                      aria-label={t("serviceDomains.access.password")}
                      placeholder={u.existing ? t("serviceDomains.access.keepPassword") : t("serviceDomains.access.password")}
                      value={u.password}
                      onChange={(e) => setUsers(users.map((x, j) => (j === i ? { ...x, password: e.target.value } : x)))}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-[38px]"
                      aria-label={t("service.remove")}
                      onClick={() => setUsers(users.filter((_, j) => j !== i))}
                    >
                      <IconTrash size={15} />
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  className="self-start"
                  onClick={() => setUsers([...users, { username: "", password: "", existing: false }])}
                >
                  <IconPlus size={14} />
                  {t("serviceDomains.access.addUser")}
                </Button>
              </div>
            )}
          </section>
          <Field label={t("serviceDomains.access.allowlist")} htmlFor="a-allow" hint={t("serviceDomains.access.allowlistHint")}>
            <Textarea
              id="a-allow"
              mono
              rows={3}
              value={allow}
              onChange={(e) => setAllow(e.target.value)}
              placeholder={"198.51.100.24\n10.0.0.0/8"}
            />
          </Field>
          <section className="flex flex-col gap-3">
            <ToggleRow
              title={t("serviceDomains.access.rateLimit")}
              description={t("serviceDomains.access.rateLimitHint")}
              control={<Switch checked={limitOn} onCheckedChange={setLimitOn} aria-label={t("serviceDomains.access.rateLimit")} />}
            />
            {limitOn && (
              <div className="grid grid-cols-3 gap-2">
                <Field label={t("serviceDomains.access.average")} htmlFor="a-avg">
                  <Input id="a-avg" inputMode="numeric" value={average} onChange={(e) => setAverage(e.target.value)} />
                </Field>
                <Field label={t("serviceDomains.access.burst")} htmlFor="a-burst">
                  <Input id="a-burst" inputMode="numeric" value={burst} onChange={(e) => setBurst(e.target.value)} />
                </Field>
                <Field label={t("serviceDomains.access.period")} htmlFor="a-period">
                  <Input id="a-period" inputMode="numeric" value={period} onChange={(e) => setPeriod(e.target.value)} />
                </Field>
              </div>
            )}
          </section>
          <section className="flex flex-col gap-2">
            <span className="text-[13.5px] font-medium">{t("serviceDomains.access.redirects")}</span>
            <span className="text-[12.5px] text-muted-foreground">{t("serviceDomains.access.redirectsHint")}</span>
            {redirects.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: unsaved form rows have no id
              <div key={`${i}-${r.from}`} className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-0 flex-1 font-mono"
                  aria-label={t("serviceDomains.access.from")}
                  placeholder="^https://shop.example.com/old/(.*)"
                  value={r.from}
                  onChange={(e) => setRedirects(redirects.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
                />
                <Input
                  className="min-w-0 flex-1 font-mono"
                  aria-label={t("serviceDomains.access.to")}
                  placeholder="https://shop.example.com/new/$1"
                  value={r.to}
                  onChange={(e) => setRedirects(redirects.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
                />
                <CheckLabel
                  className="flex items-center gap-1.5 text-[12.5px]"
                  checked={r.permanent}
                  onCheckedChange={(v) => setRedirects(redirects.map((x, j) => (j === i ? { ...x, permanent: v === true } : x)))}
                >
                  {t("serviceDomains.form.permanent")}
                </CheckLabel>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("service.remove")}
                  onClick={() => setRedirects(redirects.filter((_, j) => j !== i))}
                >
                  <IconTrash size={15} />
                </Button>
              </div>
            ))}
            <Button size="sm" className="self-start" onClick={() => setRedirects([...redirects, { from: "", to: "", permanent: false }])}>
              <IconPlus size={14} />
              {t("serviceDomains.access.addRedirect")}
            </Button>
          </section>
          {authOn && users.some((u) => !u.existing && u.password.length > 0 && u.password.length < 8) && (
            <Callout tone="warning">{t("serviceDomains.access.passwordShort")}</Callout>
          )}
          <MutationError error={save.error} />
        </SheetBody>
        <SheetFooter>
          <Button onClick={() => onOpenChange(false)}>{t("service.cancel")}</Button>
          <Button variant="primary" className="ml-auto" onClick={submit} disabled={save.isPending}>
            {t("service.save")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

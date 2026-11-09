// A Docker image, public or through a stored registry login.

import { registries, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { toast } from "@seylo/ui/components/toast";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { Field } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError, retryOp } from "../op-state";
import { CardSaveBar } from "../save-bar";
import type { ServiceDetail } from "../use-service";

const publicImage = "__public__";

export function ImageForm({ service }: { service: ServiceDetail }) {
  const src = service.sourceConfig.type === "image" ? service.sourceConfig : null;
  const [image, setImage] = useState(src?.image ?? "");
  const [registryId, setRegistryId] = useState<string | null>(src?.registryId ?? null);
  const logins = useOp(registries.list, {}, { retry: retryOp });
  const invalidate = useInvalidate();
  const save = useOpMutation(services.setSource, {
    onSuccess: () => {
      invalidate(services.get);
      toast.success(t("service.saved"));
    },
  });
  const valid = /^\S+$/.test(image.trim());

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ serviceId: service.id, source: { type: "image", image: image.trim(), registryId } });
      }}
    >
      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <Field label={t("serviceSource.image.reference")} htmlFor="image-ref" hint={t("serviceSource.image.referenceHint")}>
          <Input
            id="image-ref"
            className="font-mono"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="ghcr.io/acme/api:1.4"
          />
        </Field>
        <Field label={t("serviceSource.image.registry")}>
          <Select value={registryId ?? publicImage} onValueChange={(v) => setRegistryId(v === publicImage ? null : v)}>
            <SelectTrigger aria-label={t("serviceSource.image.registry")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={publicImage}>{t("serviceSource.image.public")}</SelectItem>
              {(logins.data?.registries ?? []).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name} · {r.server}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <CardSaveBar>
        <Button type="submit" size="sm" variant="primary" disabled={!valid || save.isPending}>
          {t("service.save")}
        </Button>
        <MutationError error={save.error} />
      </CardSaveBar>
    </form>
  );
}

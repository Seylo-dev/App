// The Source tab: where the code or image comes from (GitHub repo and
// branch, a GitLab, Gitea/Forgejo or Bitbucket repo through a connection, a
// git URL with a credential, a Docker image with a registry login, an
// inline Dockerfile, an upload), how it is built (Railpack, Nixpacks or
// Dockerfile, on which node), the watch paths and the deploy trigger URL.

import { gitProviders, type services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { SectionCard } from "@seylo/ui/components/section-card";
import { cn } from "@seylo/ui/lib/utils";
import {
  IconBrandBitbucket,
  IconBrandDocker,
  IconBrandGithub,
  IconBrandGitlab,
  IconCup,
  IconFileCode,
  IconGitBranch,
  IconUpload,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";
import { BuildSettingsCard } from "./build-settings";
import { DeployTriggerCard } from "./deploy-trigger";
import { GitForm } from "./git-form";
import { GithubForm } from "./github-form";
import { ImageForm } from "./image-form";
import { InlineForm } from "./inline-form";
import { ProviderForm, type ProviderKind } from "./provider-form";
import { UploadForm } from "./upload-form";
import { WatchPathsCard } from "./watch-paths";

type SourceType = (typeof services.Source)["static"]["type"];
/** The cards: a provider source shows as the card of its provider. */
type Pickable = Exclude<SourceType, "none" | "provider"> | ProviderKind;

const choices: { type: Pickable; icon: typeof IconBrandGithub }[] = [
  { type: "github", icon: IconBrandGithub },
  { type: "gitlab", icon: IconBrandGitlab },
  { type: "gitea", icon: IconCup },
  { type: "bitbucket", icon: IconBrandBitbucket },
  { type: "git", icon: IconGitBranch },
  { type: "image", icon: IconBrandDocker },
  { type: "inline", icon: IconFileCode },
  { type: "upload", icon: IconUpload },
];

const providerKinds: readonly string[] = ["gitlab", "gitea", "bitbucket"] satisfies ProviderKind[];

function cardOf(source: ServiceDetail["sourceConfig"]): Pickable | null {
  if (source.type === "none") return null;
  return source.type === "provider" ? source.provider : source.type;
}

/** Tiles per row on a wide card for each count, so the rows stay even. */
const wideColumns: Record<number, string> = {
  5: "@2xl:grid-cols-5",
  6: "@2xl:grid-cols-3",
  7: "@2xl:grid-cols-4",
  8: "@2xl:grid-cols-4",
};

export function SourcePage({ service }: { service: ServiceDetail }) {
  const current = cardOf(service.sourceConfig);
  const [type, setType] = useState<Pickable>(current ?? "github");
  // GitLab, Gitea and Bitbucket show only once a connection of that kind exists (or the service already uses one).
  const connections = useOp(gitProviders.list, {}, { retry: retryOp });
  const connected = new Set((connections.data?.items ?? []).map((c) => c.kind));
  const shown = choices.filter((c) => !providerKinds.includes(c.type) || connected.has(c.type as ProviderKind) || c.type === current);
  const hiddenProviders = shown.length < choices.length;
  const built = type !== "image";
  // Watch paths filter pushes, so they belong to sources that deploy on push.
  const pushed = type === "github" || type === "git" || providerKinds.includes(type);

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t("serviceSource.title")} description={t("serviceSource.description")}>
        {/* Eight tiles in even rows: 4 + 4 on a wide card, 2 per row on a narrow one, one per row on a phone. */}
        <div className="@container">
          <RadioGroup
            value={type}
            onValueChange={(v) => setType(v as Pickable)}
            aria-label={t("serviceSource.title")}
            className={cn("grid-cols-1 @md:grid-cols-2", wideColumns[shown.length] ?? "@2xl:grid-cols-4")}
          >
            {shown.map((c) => (
              <RadioCard
                key={c.type}
                value={c.type}
                icon={<c.icon size={17} stroke={1.8} />}
                title={t(`serviceSource.types.${c.type}.name`)}
                description={c.type === current ? t("serviceSource.current") : t(`serviceSource.types.${c.type}.hint`)}
              />
            ))}
          </RadioGroup>
          {hiddenProviders && connections.data && (
            <p className="m-0 mt-2.5 text-xs text-muted-foreground">
              {t("serviceSource.moreProviders")}{" "}
              <Link to="/settings/git-providers" className="font-medium">
                {t("serviceSource.moreProvidersLink")}
              </Link>
            </p>
          )}
        </div>
        <div className="border-t border-divider pt-4">
          {type === "github" && <GithubForm service={service} />}
          {(type === "gitlab" || type === "gitea" || type === "bitbucket") && <ProviderForm key={type} service={service} kind={type} />}
          {type === "git" && <GitForm service={service} />}
          {type === "image" && <ImageForm service={service} />}
          {type === "inline" && <InlineForm service={service} />}
          {type === "upload" && <UploadForm service={service} />}
        </div>
      </SectionCard>
      {built && type !== "inline" && <BuildSettingsCard service={service} />}
      {type === "inline" && <BuildSettingsCard service={service} dockerfileOnly />}
      {pushed && <WatchPathsCard service={service} />}
      <DeployTriggerCard service={service} />
    </div>
  );
}

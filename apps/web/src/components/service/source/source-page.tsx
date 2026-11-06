// The Source tab: where the code or image comes from (GitHub repo and
// branch, a git URL with a credential, a Docker image with a registry
// login, an inline Dockerfile, an upload), how it is built (Railpack,
// Nixpacks or Dockerfile, on which node), and the deploy trigger URL.

import type { services } from "@seylo/ops";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { SectionCard } from "@seylo/ui/components/section-card";
import { IconBrandDocker, IconBrandGithub, IconFileCode, IconGitBranch, IconUpload } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import type { ServiceDetail } from "../use-service";
import { BuildSettingsCard } from "./build-settings";
import { DeployTriggerCard } from "./deploy-trigger";
import { GitForm } from "./git-form";
import { GithubForm } from "./github-form";
import { ImageForm } from "./image-form";
import { InlineForm } from "./inline-form";
import { UploadForm } from "./upload-form";

type SourceType = (typeof services.Source)["static"]["type"];
type Pickable = Exclude<SourceType, "none">;

const choices: { type: Pickable; icon: typeof IconBrandGithub }[] = [
  { type: "github", icon: IconBrandGithub },
  { type: "git", icon: IconGitBranch },
  { type: "image", icon: IconBrandDocker },
  { type: "inline", icon: IconFileCode },
  { type: "upload", icon: IconUpload },
];

export function SourcePage({ service }: { service: ServiceDetail }) {
  const current = service.sourceConfig.type;
  const [type, setType] = useState<Pickable>(current === "none" ? "github" : current);
  const built = type !== "image";

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t("serviceSource.title")} description={t("serviceSource.description")}>
        <RadioGroup
          value={type}
          onValueChange={(v) => setType(v as Pickable)}
          aria-label={t("serviceSource.title")}
          className="grid-cols-[repeat(auto-fit,minmax(170px,1fr))]"
        >
          {choices.map((c) => (
            <RadioCard
              key={c.type}
              value={c.type}
              icon={<c.icon size={17} stroke={1.8} />}
              title={t(`serviceSource.types.${c.type}.name`)}
              description={c.type === current ? t("serviceSource.current") : t(`serviceSource.types.${c.type}.hint`)}
            />
          ))}
        </RadioGroup>
        <div className="border-t border-divider pt-4">
          {type === "github" && <GithubForm service={service} />}
          {type === "git" && <GitForm service={service} />}
          {type === "image" && <ImageForm service={service} />}
          {type === "inline" && <InlineForm service={service} />}
          {type === "upload" && <UploadForm service={service} />}
        </div>
      </SectionCard>
      {built && type !== "inline" && <BuildSettingsCard service={service} />}
      {type === "inline" && <BuildSettingsCard service={service} dockerfileOnly />}
      <DeployTriggerCard service={service} />
    </div>
  );
}

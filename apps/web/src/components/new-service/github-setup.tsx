// The New app dialog's GitHub tab while nothing on GitHub is connected (no
// App installation and no connected account, or a list hidden from this
// person): three short steps and the way to Settings > GitHub for owners
// and admins, whom to ask for everyone else.

import { Button } from "@seylo/ui/components/button";
import { FieldSkeleton, LoadingRegion } from "@seylo/ui/components/skeleton";
import { IconBrandGithub } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { t } from "../../i18n/t";
import { NumberedSteps } from "../numbered-steps";

export function GithubSetup({ canManage, onOpen }: { canManage: boolean; onOpen: () => void }) {
  return (
    <div data-testid="github-setup" className="flex flex-col gap-3 rounded-control bg-raised p-4">
      <span className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
        <IconBrandGithub size={16} stroke={1.8} aria-hidden="true" />
        {t("newService.githubSetup.title")}
      </span>
      {canManage ? (
        <>
          <NumberedSteps
            steps={[t("newService.githubSetup.step1"), t("newService.githubSetup.step2"), t("newService.githubSetup.step3")]}
          />
          <div>
            <Button asChild size="sm" variant="primary">
              <Link to="/settings/github" onClick={onOpen}>
                {t("newService.githubSetup.open")}
              </Link>
            </Button>
          </div>
        </>
      ) : (
        <p className="m-0 text-[13px] leading-normal text-muted-foreground">{t("newService.githubSetup.member")}</p>
      )}
    </div>
  );
}

/** The GitHub tab while the connections load: the field and branch rows. */
export function GithubTabSkeleton() {
  return (
    <LoadingRegion label={t("newService.githubSetup.loading")} className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
      <FieldSkeleton labelWidth="w-20" hint />
      <FieldSkeleton labelWidth="w-14" />
    </LoadingRegion>
  );
}

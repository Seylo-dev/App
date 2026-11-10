// Settings > Personal details (your account): your avatar (an uploaded
// image or a generated face), your name and the email you sign in with.
// Sign-in methods and sessions are on Security.

import { auth } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { createFileRoute } from "@tanstack/react-router";
import { QueryView } from "../../../components/settings/op-state";
import { FormGrid, SettingsPage } from "../../../components/settings/page";
import { AvatarCard } from "../../../components/settings/profile/avatar-card";
import { ProfileCard } from "../../../components/settings/profile/profile-card";
import { FieldSkeleton, FormActionsSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/profile")({
  component: PersonalDetailsPage,
});

function PersonalDetailsPage() {
  const me = useOp(auth.whoami, {});
  return (
    <SettingsPage title={t("settingsProfile.title")} subtitle={t("settingsProfile.subtitle")}>
      <QueryView
        query={me}
        skeleton={
          <SectionCardSkeleton titleWidth="w-16">
            <FormGrid>
              <FieldSkeleton hint={false} labelWidth="w-12" />
              <FieldSkeleton labelWidth="w-12" />
            </FormGrid>
            <FormActionsSkeleton />
          </SectionCardSkeleton>
        }
        className="flex flex-col gap-5"
      >
        {({ viewer }) => (
          <>
            <AvatarCard name={viewer.name || viewer.email} />
            {/* The fields keep what was typed: after a save they equal the saved values, after a refusal the field says why. */}
            <ProfileCard key={viewer.id} name={viewer.name} email={viewer.email} />
          </>
        )}
      </QueryView>
    </SettingsPage>
  );
}

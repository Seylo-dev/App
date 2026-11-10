import { auth } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Avatar } from "@seylo/ui/components/avatar";
import { IconLogout } from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "../../i18n/t";
import { queryClient } from "../../lib/api";

export function UserRow() {
  const navigate = useNavigate();
  const { data } = useOp(auth.whoami, {});
  const logout = useOpMutation(auth.logout, {
    onSettled: () => {
      queryClient.clear();
      void navigate({ to: "/login" });
    },
  });
  if (!data) return null;
  const { viewer } = data;

  return (
    <div className="flex items-center gap-2.5 rounded-card bg-raised p-2.5">
      {/* The name is right next to it, so screen readers skip the picture. */}
      <Avatar name={viewer.name || viewer.email} src={viewer.avatarUrl} decorative />
      <Link
        to="/settings/profile"
        title={t("nav.yourAccount")}
        className="flex min-w-0 flex-col text-foreground hover:text-foreground [&:hover_.email]:underline"
      >
        <span className="email truncate text-[13px] font-semibold">{viewer.name || viewer.email}</span>
        <span className="text-xs font-medium text-link">{t(`roles.${viewer.role}`)}</span>
      </Link>
      <button
        type="button"
        aria-label={t("nav.logout")}
        onClick={() => logout.mutate({})}
        className="ml-auto flex cursor-pointer rounded-chip border-0 bg-transparent p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <IconLogout size={16} stroke={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}

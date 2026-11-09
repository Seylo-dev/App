// One calm line under a deploy that failed to clone a plain git URL on
// GitHub, GitLab or Bitbucket with no credential: git exits with 128 (the
// agent's "could not fetch ...") both for a wrong address and for a private
// repository it may not read, so it points at the two ways in for the
// second case: the provider's own source, or a git credential.

import { Link } from "@tanstack/react-router";
import { t } from "../../i18n/t";
import type { Deployment } from "./deploy-steps";
import type { ServiceDetail } from "./use-service";

export type RepoProvider = "github" | "gitlab" | "bitbucket";

const providerHosts: Record<string, RepoProvider> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

/** Host of a git URL: https://, ssh:// or scp-like git@host:path. */
export function gitUrlHost(url: string): string | null {
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(url);
  if (scp && !url.includes("://")) return (scp[1] as string).toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Git exits 128 for a repository it cannot fetch; the agent says "could not fetch <ref> - check the address ...". */
const fetchFailed = /exit (?:status|code) 128\b|could not fetch/i;

/**
 * The provider to name when this deploy may have failed on a private
 * repository: a failed clone of a plain git URL with no credential, on a
 * host that has a connection of its own. Null otherwise.
 */
export function privateRepoProvider(
  d: Pick<Deployment, "status" | "error" | "steps">,
  source: ServiceDetail["sourceConfig"],
): RepoProvider | null {
  if (d.status !== "failed" || source.type !== "git" || source.credentialId !== null) return null;
  const clone = d.steps.find((s) => s.key === "clone");
  if (clone?.status !== "failed") return null;
  if (!fetchFailed.test(`${d.error ?? ""}\n${clone.detail}`)) return null;
  const host = gitUrlHost(source.url)?.replace(/^www\./, "");
  return (host && providerHosts[host]) || null;
}

export function PrivateRepoHint({ service, d }: { service: ServiceDetail; d: Pick<Deployment, "status" | "error" | "steps"> }) {
  const provider = privateRepoProvider(d, service.sourceConfig);
  if (!provider) return null;
  const [before, after = ""] = t("serviceDeploys.privateRepo", { provider: t(`serviceSource.types.${provider}.name`) }).split(
    "{sourceTab}",
  );
  return (
    <span data-slot="private-repo-hint" className="text-[12.5px] leading-[1.45] text-muted-foreground">
      {before}
      <Link to="/p/$projectId/s/$serviceId/source" params={{ projectId: service.projectId, serviceId: service.id }} className="font-medium">
        {t("serviceDeploys.sourceTab")}
      </Link>
      {after}
    </span>
  );
}

// One calm line under a deploy that failed to clone a plain git URL on
// GitHub, GitLab or Bitbucket with no credential: git exits with 128 (the
// agent's "could not fetch ...") both for a wrong address and for a private
// repository it may not read, so it points at the two ways in for the
// second case: the provider's own source, or a git credential.
//
// A clone that failed on the node's network (the agent says "a network
// problem on the node": a timed-out connection, a DNS server that failed,
// a proxy, TLS) gets CloneNetworkHint instead: the node, and its Health
// check (a link for owners and admins, who see the Nodes page). One that a
// wrong address gives as well (a name that does not exist, a refused
// connection: the agent says "check the address" and "If the address is
// right, the node's Health check ...") gets it too, worded the same way:
// the address first, then the Health check.

import { auth } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
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

/** The agent's words for a clone that failed on the node's network (build.GitNetworkError, agents from 0.2.17). */
const networkFailed = /\ba network problem on the node\b/;

/** Its words for one a wrong address gives as well (GitNetworkError.MaybeAddress): the address first, then the Health check. */
const addressOrNetwork = /\bIf the address is right, the node's Health check\b/;

/**
 * How the deploy's clone failed on the node's network: "network" (not the address, the branch or the credentials),
 * "address" (a name that does not exist or a refused connection: the address, else the node), null otherwise.
 */
export function cloneNetworkFailure(d: Pick<Deployment, "status" | "error" | "steps">): "network" | "address" | null {
  if (d.status !== "failed") return null;
  const clone = d.steps.find((s) => s.key === "clone");
  if (clone?.status !== "failed") return null;
  const text = `${d.error ?? ""}\n${clone.detail}`;
  if (networkFailed.test(text)) return "network";
  return addressOrNetwork.test(text) ? "address" : null;
}

/**
 * The provider to name when this deploy may have failed on a private
 * repository: a failed clone of a plain git URL with no credential, on a
 * host that has a connection of its own. Null otherwise, and for a clone
 * that failed on the node's network.
 */
export function privateRepoProvider(
  d: Pick<Deployment, "status" | "error" | "steps">,
  source: ServiceDetail["sourceConfig"],
): RepoProvider | null {
  if (d.status !== "failed" || source.type !== "git" || source.credentialId !== null) return null;
  const clone = d.steps.find((s) => s.key === "clone");
  if (clone?.status !== "failed") return null;
  if (!fetchFailed.test(`${d.error ?? ""}\n${clone.detail}`) || cloneNetworkFailure(d)) return null;
  const host = gitUrlHost(source.url)?.replace(/^www\./, "");
  return (host && providerHosts[host]) || null;
}

/** Under a deploy whose clone failed on the node's network: the node, and its Health check (after the address for "address"). */
export function CloneNetworkHint({ d }: { d: Pick<Deployment, "status" | "error" | "steps" | "builtOn"> }) {
  const role = useOp(auth.whoami, {}).data?.viewer.role;
  const failure = cloneNetworkFailure(d);
  if (!failure) return null;
  const node = d.steps.find((s) => s.key === "clone")?.node ?? d.builtOn;
  const name = node?.name ?? t("serviceDeploys.cloneNetwork.unknownNode");
  const address = failure === "address";
  if (!node || (role !== "owner" && role !== "admin")) {
    return (
      <span data-slot="clone-network-hint" className="text-[12.5px] leading-[1.45] text-muted-foreground">
        {address
          ? t("serviceDeploys.cloneNetwork.address.member", { node: name })
          : t("serviceDeploys.cloneNetwork.network.member", { node: name })}
      </span>
    );
  }
  const [before, after = ""] = (
    address
      ? t("serviceDeploys.cloneNetwork.address.admin", { node: name })
      : t("serviceDeploys.cloneNetwork.network.admin", { node: name })
  ).split("{healthCheck}");
  return (
    <span data-slot="clone-network-hint" className="text-[12.5px] leading-[1.45] text-muted-foreground">
      {before}
      <Link to="/nodes" search={{ node: node.id, view: "health" }} className="font-medium">
        {t("serviceDeploys.cloneNetwork.healthCheck")}
      </Link>
      {after}
    </span>
  );
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

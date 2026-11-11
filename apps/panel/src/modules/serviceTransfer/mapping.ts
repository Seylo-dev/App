// What reads an imported service's source on this panel. The file names
// what read it on the old panel (an App installation's account, the
// connected GitHub account's login, a git credential's host and user, a
// provider's address, a registry's server and user); here that becomes a
// row of this panel, picked by the same names, or a choice for the owner.
// Nothing panel-wide is created from the file except, on request, the git
// credential or registry login the exporter included.

import { git as gitOps, OpError, registries as registryOps, type serviceTransfer as transferOps } from "@seylo/ops";
import { Value } from "@sinclair/typebox/value";
import { asc, eq, isNull } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { gitCredentials, githubInstallations, gitProviders, registryCredentials } from "../../db/schema";
import { type NewCredential, newCredential } from "../git/credentials";
import { recordedHostOf } from "../git/targets";
import { accountLogin, connectedAccount } from "../github/account";
import { type RegistryLogin, registryLogin } from "../registries/login";
import { registryMatches } from "../services/source-guard";
import type { ServiceSpecJson } from "../services/spec";
import type { ServiceSecrets } from "./snapshot";

type Doc = transferOps.PortableServiceV1;
export type AccessKind = "githubInstallation" | "githubAccount" | "gitCredential" | "gitProvider" | "registry" | "createFromFile" | "none";

export interface AccessOption {
  kind: AccessKind;
  id: string | null;
  name: string;
}

export interface AccessPlan {
  /** False: the source needs nothing (an image without a login, inline, upload, none). */
  needed: boolean;
  options: AccessOption[];
  /** The option the file's names point at, or null when nothing here matches. */
  match: AccessOption | null;
  /** What the file says read it, for display. */
  wanted: string | null;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function accessPlan(db: PanelDb, doc: Doc, secrets: ServiceSecrets | null): AccessPlan {
  const source = doc.spec.source;
  const wanted = doc.sourceAccess;
  const none = (name: string): AccessOption => ({ kind: "none", id: null, name });
  if (source.type === "github") {
    const owner = source.repo.split("/")[0] ?? "";
    const installations = db
      .select()
      .from(githubInstallations)
      .where(isNull(githubInstallations.suspendedAt))
      .orderBy(asc(githubInstallations.accountLogin))
      .all();
    const account = connectedAccount(db);
    const options: AccessOption[] = [
      ...installations.map((i) => ({ kind: "githubInstallation" as const, id: i.id, name: `GitHub App on ${i.accountLogin}` })),
      ...(account ? [{ kind: "githubAccount" as const, id: account.id, name: `GitHub account ${accountLogin(account)}` }] : []),
      none("Import without a source"),
    ];
    const byInstallation = (login: string | null | undefined) => {
      const i = installations.find((row) => same(row.accountLogin, login));
      return i ? (options.find((o) => o.id === i.id) ?? null) : null;
    };
    const byAccount = (login: string | null | undefined) =>
      account && same(accountLogin(account), login) ? (options.find((o) => o.id === account.id) ?? null) : null;
    const match =
      (wanted?.via === "githubInstallation" ? byInstallation(wanted.account) : null) ??
      (wanted?.via === "githubAccount" ? byAccount(wanted.login) : null) ??
      byInstallation(owner) ??
      byAccount(owner);
    return { needed: true, options, match, wanted: wanted ? describeWanted(wanted) : `GitHub ${source.repo}` };
  }
  if (source.type === "provider") {
    const rows = db.select().from(gitProviders).where(eq(gitProviders.kind, source.provider)).orderBy(asc(gitProviders.name)).all();
    const options: AccessOption[] = [
      ...rows.map((r) => ({ kind: "gitProvider" as const, id: r.id, name: `${r.name} (${r.url})` })),
      none("Import without a source"),
    ];
    const row =
      wanted?.via === "gitProvider"
        ? rows.find(
            (r) => same(r.url.replace(/\/+$/, ""), wanted.url.replace(/\/+$/, "")) && (r.workspace ?? null) === (wanted.workspace ?? null),
          )
        : undefined;
    return {
      needed: true,
      options,
      match: row ? (options.find((o) => o.id === row.id) ?? null) : null,
      wanted: wanted ? describeWanted(wanted) : null,
    };
  }
  if (source.type === "git") {
    const host = recordedHostOf(source.url);
    const rows = host ? db.select().from(gitCredentials).where(eq(gitCredentials.host, host)).orderBy(asc(gitCredentials.name)).all() : [];
    const fromFile = secrets?.sourceCredential?.kind === "gitCredential" && wanted?.via === "gitCredential";
    const options: AccessOption[] = [
      ...rows.map((r) => ({
        kind: "gitCredential" as const,
        id: r.id,
        name: `${r.name} (${r.host}${r.username ? `, ${r.username}` : ""})`,
      })),
      ...(fromFile ? [{ kind: "createFromFile" as const, id: null, name: `Create ${wanted.name} from the file` }] : []),
      none("Public repository, no credential"),
    ];
    if (wanted?.via !== "gitCredential") return { needed: false, options, match: options[options.length - 1] ?? null, wanted: null };
    const row = rows.find(
      (r) =>
        r.kind === wanted.kind &&
        (r.username ?? null) === (wanted.username ?? null) &&
        (r.kind !== "ssh_key" || r.fingerprint === wanted.fingerprint),
    );
    const match = row
      ? (options.find((o) => o.id === row.id) ?? null)
      : fromFile
        ? (options.find((o) => o.kind === "createFromFile") ?? null)
        : null;
    return { needed: true, options, match, wanted: describeWanted(wanted) };
  }
  if (source.type === "image") {
    const rows = db
      .select()
      .from(registryCredentials)
      .orderBy(asc(registryCredentials.name))
      .all()
      .filter((r) => registryMatches(r.server, source.image));
    const fromFile = secrets?.sourceCredential?.kind === "registry" && wanted?.via === "registry";
    const options: AccessOption[] = [
      ...rows.map((r) => ({ kind: "registry" as const, id: r.id, name: `${r.name} (${r.server}, ${r.username})` })),
      ...(fromFile ? [{ kind: "createFromFile" as const, id: null, name: `Create ${wanted.name} from the file` }] : []),
      none("Public image, no login"),
    ];
    if (wanted?.via !== "registry") return { needed: false, options, match: options[options.length - 1] ?? null, wanted: null };
    const row = rows.find((r) => same(r.server, wanted.server) && r.username === wanted.username);
    const match = row
      ? (options.find((o) => o.id === row.id) ?? null)
      : fromFile
        ? (options.find((o) => o.kind === "createFromFile") ?? null)
        : null;
    return { needed: true, options, match, wanted: describeWanted(wanted) };
  }
  return { needed: false, options: [], match: null, wanted: null };
}

function describeWanted(wanted: NonNullable<Doc["sourceAccess"]>): string {
  switch (wanted.via) {
    case "githubInstallation":
      return `GitHub App on ${wanted.account}`;
    case "githubAccount":
      return `GitHub account ${wanted.login}`;
    case "gitCredential":
      return `Git credential ${wanted.name} (${wanted.host}${wanted.username ? `, ${wanted.username}` : ""})`;
    case "gitProvider":
      return `${wanted.provider} at ${wanted.url}`;
    case "registry":
      return `Registry login ${wanted.name} (${wanted.server}, ${wanted.username})`;
  }
}

/**
 * The source as this panel stores it, with the picked row's id
 * (`createdId` for a credential made from the file). A repository that
 * nothing reads here becomes no source.
 */
export function sourceFor(
  doc: Doc,
  pick: AccessOption | null,
  options: { deployOnPush: boolean; createdId?: string | null },
): ServiceSpecJson["source"] {
  const s = doc.spec.source;
  const id = pick?.kind === "createFromFile" ? (options.createdId ?? null) : (pick?.id ?? null);
  switch (s.type) {
    case "github":
      if (pick?.kind === "githubInstallation" && id)
        return { type: "github", installationId: id, accountId: null, repo: s.repo, branch: s.branch, deployOnPush: options.deployOnPush };
      if (pick?.kind === "githubAccount" && id)
        return { type: "github", installationId: null, accountId: id, repo: s.repo, branch: s.branch, deployOnPush: options.deployOnPush };
      return { type: "none" };
    case "provider":
      if (pick?.kind === "gitProvider" && id)
        return {
          type: "provider",
          providerId: id,
          provider: s.provider,
          repo: s.repo,
          branch: s.branch,
          deployOnPush: options.deployOnPush,
        };
      return { type: "none" };
    case "git":
      return {
        type: "git",
        url: s.url,
        branch: s.branch,
        credentialId: pick?.kind === "gitCredential" || pick?.kind === "createFromFile" ? id : null,
        deployOnPush: options.deployOnPush,
      };
    case "image":
      return { type: "image", image: s.image, registryId: pick?.kind === "registry" || pick?.kind === "createFromFile" ? id : null };
    case "upload":
      return { type: "upload", fileName: null };
    case "inline":
      return { type: "inline" };
    case "none":
      return { type: "none" };
  }
}

export type FileCredential =
  | ({ kind: "gitCredential" } & ReturnType<typeof newCredential>)
  | { kind: "registry"; name: string; login: RegistryLogin };

/**
 * The credential to create from the file (createFromFile), sealed by the
 * caller. It goes through git.createCredential's checks (the host's shape
 * and case, known_hosts lines for it, a key the panel can read: the public
 * key and fingerprint come from the key, never from the file) and
 * registries.create's input rules. registries.create also tries the login;
 * an import does not, so a registry the panel cannot reach does not stop
 * it. BAD_REQUEST field sourceAccess when the file's does not pass.
 */
export function credentialFromFile(doc: Doc, secrets: ServiceSecrets | null): FileCredential | null {
  const wanted = doc.sourceAccess;
  const cred = secrets?.sourceCredential;
  const refused = (what: string, error?: unknown) =>
    new OpError(
      "BAD_REQUEST",
      `The ${what} in the file does not pass this panel's checks.${error instanceof OpError ? ` ${error.message}` : ""} Pick another way to read the source.`,
      { field: "sourceAccess", reason: "sourceAccess" },
    );
  if (wanted?.via === "gitCredential" && cred?.kind === "gitCredential") {
    const input: NewCredential = {
      name: (wanted.name.trim() || wanted.host).slice(0, 60),
      kind: wanted.kind,
      host: wanted.host,
      ...(wanted.kind === "token"
        ? { token: cred.secret, ...(wanted.username ? { username: wanted.username } : {}) }
        : { privateKey: cred.secret }),
      ...(cred.knownHosts ? { knownHosts: cred.knownHosts } : {}),
    };
    if (!Value.Check(gitOps.createCredential.input, input)) throw refused("git credential");
    try {
      return { kind: "gitCredential", ...newCredential(input) };
    } catch (error) {
      throw refused("git credential", error);
    }
  }
  if (wanted?.via === "registry" && cred?.kind === "registry") {
    const input = {
      name: (wanted.name.trim() || wanted.server).slice(0, 60),
      server: wanted.server,
      username: wanted.username,
      password: cred.password,
    };
    if (!Value.Check(registryOps.create.input, input)) throw refused("registry login");
    return { kind: "registry", name: input.name.trim(), login: registryLogin(input) };
  }
  return null;
}

/** Names of panel-wide rows (channels, destinations) compare trimmed and without case. */
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

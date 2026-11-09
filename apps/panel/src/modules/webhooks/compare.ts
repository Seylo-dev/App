// The compare API of a service's source, for watch paths when a push does
// not list its files (deploy trigger URL calls with ?commit=). GitHub goes
// through the App, GitLab, Gitea/Forgejo and Bitbucket through their
// connection; a plain git URL has no API, so its files stay unknown.

import type { Deps } from "../../deps";
import { githubSourceAuth } from "../github/account";
import { githubCompare } from "../github/app";
import { clientFor } from "../gitProviders/client";
import { loadProvider } from "../gitProviders/rows";
import type { ServiceSpecJson } from "../services/spec";
import type { CompareFiles } from "./gate";

export function compareForSource(deps: Pick<Deps, "db" | "secrets">, source: ServiceSpecJson["source"]): CompareFiles {
  if (source.type === "github") {
    return async (before, after) => githubCompare((await githubSourceAuth(deps, source)).token, source.repo, before, after);
  }
  if (source.type === "provider") {
    return (before, after) => clientFor(deps, loadProvider(deps.db, source.providerId)).compare(source.repo, before, after);
  }
  return null;
}

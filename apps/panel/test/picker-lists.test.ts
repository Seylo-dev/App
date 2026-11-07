// The shared pickers (registry logins, git credentials, git provider
// connections, notification channels, backup destinations, the GitHub App
// and its installations) are for people who may use them somewhere: an
// account whose grants were all removed gets empty lists, not the panel's
// catalogue of hosts, buckets, channels and GitHub accounts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { backups, git, github, gitProviders, notifications, projects, registries } from "@seylo/ops";
import { gitCredentials, githubApps, githubInstallations, gitProviders as providerRows, registryCredentials } from "../src/db/schema";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let owner: string;
let projectId: string;

beforeEach(async () => {
  panel = testPanel();
  ({ cookie: owner } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "apps" }, { cookie: owner })).body.id;
  const { db, secrets } = panel.deps;
  db.insert(registryCredentials)
    .values({ name: "GHCR", server: "ghcr.io", username: "bot", passwordSealed: secrets.seal("p", "registry.credential") })
    .run();
  db.insert(gitCredentials)
    .values({ name: "deploy token", kind: "token", host: "github.com", secretSealed: secrets.seal("t", "git.credential") })
    .run();
  db.insert(providerRows)
    .values({ kind: "gitlab", name: "GitLab", url: "https://gitlab.example.com", tokenSealed: secrets.seal("t", "git.provider") })
    .run();
  const app = db
    .insert(githubApps)
    .values({
      appId: 1,
      slug: "acme-seylo",
      name: "Acme Seylo",
      htmlUrl: "https://github.com/apps/acme-seylo",
      ownerLogin: "acme",
      clientId: "c",
      clientSecretSealed: secrets.seal("cs", "github.app"),
      privateKeySealed: secrets.seal("k", "github.app"),
      webhookSecretSealed: secrets.seal("w", "github.app"),
    })
    .returning()
    .get();
  db.insert(githubInstallations)
    .values({ githubAppId: app.id, installationId: 7, accountLogin: "acme-private-org", accountType: "Organization" })
    .run();
  const channel = await callOp(
    panel,
    notifications.createChannel,
    { name: "Ops Discord", config: { kind: "discord", webhookUrl: "https://discord.com/api/webhooks/1/x" } },
    { cookie: owner },
  );
  expect(channel.status).toBe(200);
  const destination = await callOp(
    panel,
    backups.createDestination,
    {
      name: "R2 eu",
      provider: "minio",
      endpoint: "http://127.0.0.1:9",
      region: "auto",
      bucket: "secret-bucket-name",
      pathPrefix: "",
      pathStyle: true,
      accessKeyId: "AK",
      secretAccessKey: "SK",
    },
    { cookie: owner },
  );
  expect(destination.status).toBe(200);
});
afterEach(() => panel.close());

async function lists(options: { cookie?: string; bearer?: string }) {
  const read = async <T>(promise: Promise<{ status: number; body: T }>) => {
    const result = await promise;
    expect(result.status).toBe(200);
    return result.body;
  };
  return {
    registries: (await read(callOp(panel, registries.list, {}, options))).registries.length,
    credentials: (await read(callOp(panel, git.listCredentials, {}, options))).items.length,
    providers: (await read(callOp(panel, gitProviders.list, {}, options))).items.length,
    channels: (await read(callOp(panel, notifications.channels, {}, options))).channels.length,
    destinations: (await read(callOp(panel, backups.listDestinations, {}, options))).choices.length,
    githubApp: ((await read(callOp(panel, github.status, {}, options))).app?.ownerLogin ?? null) as string | null,
    installations: ((await read(callOp(panel, github.installations, {}, options))).installations as { accountLogin: string }[]).map(
      (i) => i.accountLogin,
    ),
  };
}

const none = { registries: 0, credentials: 0, providers: 0, channels: 0, destinations: 0, githubApp: null, installations: [] };
const everything = {
  registries: 1,
  credentials: 1,
  providers: 1,
  channels: 1,
  destinations: 1,
  githubApp: "acme",
  installations: ["acme-private-org"],
};

test("an account with no grants gets empty pickers", async () => {
  const nobody = await createUser(panel, "member");
  expect(await lists({ cookie: nobody.cookie })).toEqual(none);
  // Not even the install link, which names the App.
  expect((await callOp(panel, github.installations, {}, { cookie: nobody.cookie })).body.installUrl).toBeNull();
});

test("owners and admins see the GitHub App and its installations", async () => {
  expect(await lists({ cookie: owner })).toEqual(everything);
  const admin = await createUser(panel, "admin");
  expect(await lists({ cookie: admin.cookie })).toEqual(everything);
  expect((await callOp(panel, github.installations, {}, { cookie: admin.cookie })).body.installUrl).toContain("acme-seylo");
});

test("a viewer reads channel and destination names; source pickers need a source edit right", async () => {
  const viewer = await createUser(panel, "member");
  grant(panel, viewer.user.id, "project", projectId, ["services.view"]);
  expect(await lists({ cookie: viewer.cookie })).toEqual({ ...none, channels: 1, destinations: 1 });

  const builder = await createUser(panel, "member");
  grant(panel, builder.user.id, "project", projectId, ["services.view", "services.create"]);
  expect(await lists({ cookie: builder.cookie })).toEqual(everything);

  const editor = await createUser(panel, "member");
  grant(panel, editor.user.id, "project", projectId, ["services.view", "services.update"]);
  expect(await lists({ cookie: editor.cookie })).toEqual(everything);
});

test("a key follows its owner's grants and its own project list", async () => {
  const builder = await createUser(panel, "member");
  grant(panel, builder.user.id, "project", projectId, ["*"]);
  const all = createApiKey(panel, builder.user.id, { readOnly: true });
  expect((await lists({ bearer: all })).registries).toBe(1);

  const other = (await callOp(panel, projects.create, { name: "other" }, { cookie: owner })).body.id as string;
  const elsewhere = createApiKey(panel, builder.user.id, { readOnly: true, projectIds: [other] });
  expect(await lists({ bearer: elsewhere })).toEqual(none);

  const ownerKey = createApiKey(panel, (await createUser(panel, "owner")).user.id, { readOnly: true });
  expect(await lists({ bearer: ownerKey })).toEqual(everything);
});

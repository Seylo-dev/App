// Service export and import on the demo data: the Export card and dialog
// on the Settings tab (owners only, passphrase rules, volume data and the
// stop it needs, re-auth, the download), the note under the service header
// while a download or an import's upload runs, and the Import page from
// the New service menu (reading the file in the browser, damaged files,
// the review choices, basic auth passwords, the archive and volume data
// going up in parts with Retry, going on after the page was closed).

import { ids } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { installDemo } from "./demo/routes";
import { servicesById } from "./demo/service";
import { exportFile, exportPreview, importPreview, manifestSha256, overlapFile, symlinkFile } from "./demo/transfer";
import { expect, stateFile, test } from "./helpers";

const shots = process.env.SHOTS_DIR ?? "shots";
const settingsPage = `/p/${ids.acme}/s/${ids.api}/settings`;

test.describe("service export", () => {
  test.use({ storageState: stateFile });

  test("an owner exports with a passphrase after confirming it is them; the link downloads the file", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    let asked = 0;
    await installDemo(page, {
      overrides: {
        "serviceTransfer.exportPreview": () => exportPreview,
        "serviceTransfer.export": (input) => {
          sent.push(input);
          // A stale session first: the re-auth dialog, then the same call again.
          if (asked++ === 0) throw new DemoRefusal(403, "FORBIDDEN", "Confirm it's you to continue.", { reason: "reauth" });
          return {
            exportId: "export0000000001",
            fileName: "api-20261111-1200.seylo.zip",
            download: { url: "/api/transfer/export?t=demo-ticket", ticket: "demo-ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() },
          };
        },
        "auth.reauth": () => ({ freshUntil: new Date(Date.now() + 15 * 60_000).toISOString() }),
      },
    });
    const zip = await exportFile(2000);
    await page.route("**/api/transfer/export?t=demo-ticket", (route) =>
      route.fulfill({ status: 200, headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="api-20261111-1200.seylo.zip"' }, body: zip }),
    );
    await page.goto(settingsPage);
    const card = page.getByRole("region", { name: "Export" }).or(page.locator("section", { has: page.getByRole("heading", { name: "Export" }) }));
    await expect(card.getByText("Download this service as a .zip")).toBeVisible();
    await card.getByRole("button", { name: "Export…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Export api" })).toBeVisible();
    await expect(dialog.getByText("12 environment variables")).toBeVisible();
    await expect(dialog.getByText("Domain api.acme.dev")).toBeVisible();
    await expect(dialog.getByText("2 cron jobs")).toBeVisible();
    // Volume data goes in by default, and the service stops while it is read.
    const volume = dialog.getByRole("checkbox", { name: "uploads, mounted at /app/uploads" });
    await expect(volume).toBeChecked();
    const stop = dialog.getByRole("checkbox", { name: "Stop api while its data is read, so it is consistent" });
    await expect(stop).toBeChecked();
    await expect(dialog.getByText("api stops before the download starts and stays stopped until it ends.")).toBeVisible();
    await expect(dialog.getByText("The uploaded archive and volume data are not encrypted")).toBeVisible();
    await stop.click();
    await expect(dialog.getByText("api stops before the download starts")).toHaveCount(0);
    await stop.click();
    // Leaving values out says what that means.
    await dialog.getByRole("radio", { name: /Leave secret values out/ }).click();
    await expect(dialog.getByText("Commands, URLs, host names and notes are in the file as they are.")).toBeVisible();
    await dialog.getByRole("radio", { name: /Encrypt with a passphrase/ }).click();
    const download = dialog.getByRole("button", { name: "Download .zip" });
    await dialog.getByLabel("Passphrase", { exact: true }).fill("too short");
    await expect(dialog.getByText("Use at least 12 characters.")).toBeVisible();
    await expect(download).toBeDisabled();
    await dialog.getByLabel("Passphrase", { exact: true }).fill("correct horse battery staple");
    await dialog.getByLabel("Passphrase again").fill("correct horse battery");
    await expect(dialog.getByText("The two passphrases differ.")).toBeVisible();
    await dialog.getByLabel("Passphrase again").fill("correct horse battery staple");
    await dialog.getByRole("checkbox", { name: "Include the git credential deploy-bot (encrypted)" }).click();
    await page.screenshot({ path: `${shots}/export-dialog.png` });
    await download.click();
    // The re-auth dialog, then the download.
    const reauth = page.getByRole("dialog").filter({ hasText: "Confirm" });
    await reauth.getByLabel("Password").fill("correct horse battery");
    const downloaded = page.waitForEvent("download");
    await reauth.getByRole("button", { name: "Confirm" }).click();
    expect((await downloaded).suggestedFilename()).toBe("api-20261111-1200.seylo.zip");
    await expect(page.getByText("Your download of api-20261111-1200.seylo.zip has started.")).toBeVisible();
    expect(sent.at(-1)).toEqual({
      serviceId: ids.api,
      secrets: "encrypted",
      passphrase: "correct horse battery staple",
      includeSourceLogin: true,
      volumes: ["uploads"],
      stopService: true,
    });
    await expect(page.getByText("Waiting for the download to start…")).toBeVisible();
  });

  test("a database's data needs a passphrase and always stops it; without data the volumes arrive empty", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "serviceTransfer.exportPreview": () => ({
          ...exportPreview,
          kind: "postgres",
          volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
          data: { ...exportPreview.data, database: true },
          sourceLogin: null,
        }),
        "serviceTransfer.export": (input) => {
          sent.push(input);
          return {
            exportId: "export0000000002",
            fileName: "api-20261111-1200.seylo.zip",
            download: { url: "/api/transfer/export?t=demo-db", ticket: "demo-db", expiresAt: new Date(Date.now() + 60_000).toISOString() },
            stopsService: true,
          };
        },
      },
    });
    await page.route("**/api/transfer/export?t=demo-db", (route) => route.fulfill({ status: 200, headers: { "content-type": "application/zip" }, body: "" }));
    await page.goto(settingsPage);
    await page.getByRole("button", { name: "Export…" }).click();
    const dialog = page.getByRole("dialog");
    const data = dialog.getByRole("checkbox", { name: "The data of api" });
    await expect(data).toBeChecked();
    const stop = dialog.getByRole("checkbox", { name: "api is a database: it is always stopped while its data is read" });
    await expect(stop).toBeChecked();
    await expect(stop).toBeDisabled();
    await dialog.getByRole("radio", { name: /Leave secret values out/ }).click();
    await expect(dialog.getByText("A database's data only goes in an encrypted file: its logins go with it.")).toBeVisible();
    await expect(data).toBeDisabled();
    await expect(data).not.toBeChecked();
    await dialog.getByRole("button", { name: "Download .zip" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ serviceId: ids.api, secrets: "omitted" });
  });

  test("while a download reads its data the service page says so, and Stop the export starts it again", async ({ page }) => {
    const cancels: Record<string, unknown>[] = [];
    let stopped = true;
    await installDemo(page, {
      overrides: {
        "services.get": () => ({
          ...servicesById[ids.api],
          stopped,
          transfer: stopped
            ? {
                kind: "export",
                id: "export0000000001",
                status: "streaming",
                bytes: 3 * 1024 * 1024,
                totalBytes: null,
                stopped: true,
                volumes: ["uploads"],
                sha256: null,
                error: null,
                startedAt: new Date().toISOString(),
                finishedAt: null,
              }
            : null,
        }),
        "serviceTransfer.cancelExport": (input) => {
          cancels.push(input);
          stopped = false;
          return { cancelled: true };
        },
      },
    });
    await page.goto(`/p/${ids.acme}/s/${ids.api}`);
    await expect(page.getByText("api is stopped while an export downloads its data (3.1 MB so far).")).toBeVisible();
    await page.getByRole("button", { name: "Stop the export" }).click();
    await expect.poll(() => cancels.length).toBe(1);
    expect(cancels[0]).toEqual({ serviceId: ids.api, exportId: "export0000000001" });
  });

  test("members do not see the Export card", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "auth.whoami": () => ({ viewer: { id: "user000000000002", email: "dev@example.com", name: "", role: "member" }, via: "session" }),
      },
    });
    await page.goto(settingsPage);
    await expect(page.getByRole("heading", { name: "Rename" }).or(page.getByRole("heading", { name: "Name" })).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Export…" })).toHaveCount(0);
  });
});

/** getImport's answer for an import that waits for these entries. */
function receiving(entries: { path: string; kind: "upload" | "volume"; size: number; received: number; volume?: string }[], manifest = "0".repeat(64)) {
  return {
    importId: "import0000000001",
    status: "receiving",
    serviceId: "svcweb200000000a",
    manifestSha256: manifest,
    entries: entries.map((e) => ({ volume: null, sha256: "0".repeat(64), status: "pending", error: null, ...e })),
    deployWhenReady: false,
    expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
  };
}

const part = 32 * 1024 * 1024;

test.describe("service import", () => {
  test.use({ storageState: stateFile });

  test("the New service menu opens the import page; damaged files are refused in the browser", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}`);
    await page.getByRole("button", { name: "New service" }).click();
    await page.getByRole("menuitem", { name: /Import from a file/ }).click();
    await expect(page).toHaveURL(new RegExp(`/import\\?project=${ids.acme}`));
    await expect(page.getByRole("heading", { name: "Import a service" })).toBeVisible();
    const picker = page.getByLabel("Pick a .zip file");
    await picker.setInputFiles({ name: "evil.zip", mimeType: "application/zip", buffer: await symlinkFile() });
    await expect(page.getByRole("alert")).toContainText("is a symbolic link");
    await picker.setInputFiles({ name: "bomb.zip", mimeType: "application/zip", buffer: await overlapFile() });
    await expect(page.getByRole("alert")).toContainText("overlaps");
    await picker.setInputFiles({ name: "notes.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip file at all") });
    await expect(page.getByRole("alert")).toContainText("This is not a zip file");
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("file, passphrase, review choices, basic auth password, the archive in parts with Retry, then the service", async ({ page }) => {
    const calls: { op: string; input: Record<string, unknown> }[] = [];
    let preview = importPreview();
    let puts = 0;
    await installDemo(page, {
      overrides: {
        "serviceTransfer.importBegin": (input) => {
          calls.push({ op: "importBegin", input });
          if (input.passphrase !== "correct horse battery staple") {
            throw new DemoRefusal(403, "FORBIDDEN", "That passphrase does not open this file.", { reason: "passphrase", field: "passphrase" });
          }
          return preview;
        },
        "serviceTransfer.setChoices": (input) => {
          calls.push({ op: "setChoices", input });
          const choices = input.choices as Record<string, unknown>;
          const picked = choices.sourceAccess as { kind: string; id?: string } | undefined;
          preview = importPreview({
            choices: { ...preview.choices, ...choices },
            needs: picked ? [] : preview.needs,
            source: { ...preview.source, access: { ...preview.source.access, picked: picked ? preview.source.access.options.find((o) => o.kind === picked.kind) : null } },
          });
          return preview;
        },
        "serviceTransfer.import": (input) => {
          calls.push({ op: "import", input });
          return {
            service: { id: "svcweb200000000a", projectId: ids.acme, name: "web-2", stopped: true },
            importId: "import0000000001",
            pending: [{ entry: "services/web/source/upload.tar.gz", sizeBytes: 300_000, kind: "upload", volume: null }],
            deployTrigger: { url: "https://panel.acme.dev/api/hooks/deploy/seylo_hook_demo" },
            skipped: [],
          };
        },
        "serviceTransfer.getImport": () => receiving([{ path: "services/web/source/upload.tar.gz", kind: "upload", size: 300_000, received: 0 }]),
        "serviceTransfer.uploadTicket": (input) => {
          calls.push({ op: "uploadTicket", input });
          return { url: `/api/transfer/import?t=part-${input.offset}`, ticket: `part-${input.offset}`, expiresAt: new Date(Date.now() + 60_000).toISOString() };
        },
      },
    });
    const sizes: number[] = [];
    await page.route("**/api/transfer/import?t=*", async (route) => {
      const body = route.request().postDataBuffer();
      // The first part fails once: Retry starts the entry over.
      if (puts++ === 0) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "BAD_REQUEST", message: "The archive does not match the file's manifest (sha256)." } }) });
      sizes.push(body?.length ?? 0);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ received: body?.length ?? 0, done: true }) });
    });

    await page.goto(`/import?project=${ids.acme}`);
    await page.getByLabel("Pick a .zip file").setInputFiles({ name: "web-20261111-1200.seylo.zip", mimeType: "application/zip", buffer: await exportFile(300_000) });
    await expect(page.getByText("Encrypted with a passphrase")).toBeVisible();
    await page.getByLabel("Passphrase").fill("wrong one");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("That passphrase does not open this file.")).toBeVisible();
    await page.getByLabel("Passphrase").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();
    // What importBegin got: the small entries as text, never the archive.
    const begun = calls.filter((c) => c.op === "importBegin").at(-1)?.input as Record<string, unknown>;
    expect(Object.keys(begun).sort()).toEqual(["manifest", "passphrase", "projectId", "secretsEnc", "signature"]);
    expect(String(begun.manifest)).toContain('"format":"service-export"');

    // Review: the open choice, the clash, the domain in use, the password field.
    await expect(page.getByText("1 thing needs you before the import")).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("web-2");
    await expect(page.getByTestId("domain-shop.acme.dev").getByText("used here")).toBeVisible();
    await expect(page.getByTestId("domain-admin.acme.dev").getByText("needs a password")).toBeVisible();
    await expect(page.getByText("DATABASE_URL")).toBeVisible();
    const importButton = page.getByRole("button", { name: "Import", exact: true });
    await expect(importButton).toBeDisabled();
    await page.getByLabel("Read with").click();
    await page.getByRole("option", { name: "GitHub account octo" }).click();
    await expect(page.getByText("Ready to import.")).toBeVisible();
    // Still disabled until the basic auth password is typed.
    await expect(importButton).toBeDisabled();
    await page.getByLabel("New password for admin").fill("a new admin password");
    await page.screenshot({ path: `${shots}/import-review.png`, fullPage: true });
    await importButton.click();

    // The archive: the first PUT fails, Retry sends it again.
    await expect(page.getByText("The upload failed: The archive does not match the file's manifest (sha256).")).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "web-2 is imported" })).toBeVisible();
    await expect(page.getByText("It deploys now.")).toBeVisible();
    await expect(page.getByText("https://panel.acme.dev/api/hooks/deploy/seylo_hook_demo")).toBeVisible();
    expect(sizes).toEqual([300_000]);
    const imported = calls.find((c) => c.op === "import")?.input;
    expect(imported).toEqual({ projectId: ids.acme, importId: "import0000000001", passwords: [{ host: "admin.acme.dev", pathPrefix: "/", username: "admin", password: "a new admin password" }] });
    // Passwords never go to setChoices.
    expect(calls.filter((c) => c.op === "setChoices").some((c) => JSON.stringify(c.input).includes("a new admin password"))).toBe(false);
    expect(calls.filter((c) => c.op === "uploadTicket").map((c) => c.input.offset)).toEqual([0, 0]);
    await page.getByRole("button", { name: "Open web-2" }).click();
    await expect(page).toHaveURL(new RegExp("/s/svcweb200000000a"));
  });

  test("Discard after a failed upload says why when the panel keeps the service", async ({ page }) => {
    let discards = 0;
    await installDemo(page, {
      overrides: {
        "serviceTransfer.importBegin": () => importPreview({ needs: [] }),
        "serviceTransfer.setChoices": (input) => importPreview({ choices: { ...importPreview().choices, ...(input.choices as object) }, needs: [] }),
        "serviceTransfer.import": () => ({
          service: { id: "svcweb200000000a", projectId: ids.acme, name: "web-2", stopped: true },
          importId: "import0000000001",
          pending: [{ entry: "services/web/source/upload.tar.gz", sizeBytes: 300_000, kind: "upload", volume: null }],
          deployTrigger: null,
          skipped: [],
        }),
        "serviceTransfer.getImport": () => receiving([{ path: "services/web/source/upload.tar.gz", kind: "upload", size: 300_000, received: 0 }]),
        "serviceTransfer.uploadTicket": (input) => ({
          url: `/api/transfer/import?t=part-${input.offset}`,
          ticket: `part-${input.offset}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        "serviceTransfer.discardImport": () => {
          discards++;
          throw new DemoRefusal(409, "CONFLICT", "web-2 is protected, so discarding its import does not delete it. Turn protection off first.", {
            reason: "protected",
          });
        },
      },
    });
    await page.route("**/api/transfer/import?t=*", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "The node is offline." } }) }),
    );
    await page.goto(`/import?project=${ids.acme}`);
    await page.getByLabel("Pick a .zip file").setInputFiles({ name: "web-20261111-1200.seylo.zip", mimeType: "application/zip", buffer: await exportFile(300_000) });
    await page.getByLabel("Passphrase").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("New password for admin").fill("a new admin password");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("The upload failed: The node is offline.")).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText("web-2 is protected, so discarding its import does not delete it.")).toBeVisible();
    expect(discards).toBe(1);
    await expect(page).toHaveURL(/\/import/);
  });

  test("volume data: picked on the review page, confirmed, sent in 32 MiB parts, a broken part goes on from what the panel has", async ({
    page,
  }) => {
    const volumeBytes = part + 1_000_000;
    let preview = importPreview({
      needs: [],
      choices: { ...importPreview().choices, upload: false, volumes: ["data"] },
      data: {
        volumes: [{ name: "data", mountPath: "/data", inFile: true, sizeBytes: volumeBytes, unpackedBytes: volumeBytes * 300, include: true }],
        upload: null,
        neededBytes: volumeBytes * 303 + 16 * 1024 * 1024,
        node: { freeBytes: 40 * 1024 ** 3, totalBytes: 80 * 1024 ** 3 },
      },
    });
    const withNeeds = (p: ReturnType<typeof importPreview>) => {
      const choices = p.choices as { volumes: string[]; confirmData: boolean };
      return choices.volumes.length > 0 && !choices.confirmData
        ? [{ reason: "dataRatio", field: "confirmData", message: "data unpacks to more than 200 times its size. Confirm it on the Data section." }]
        : [];
    };
    preview = { ...preview, needs: withNeeds(preview) };
    const tickets: number[] = [];
    const putSizes: number[] = [];
    let received = 0;
    let puts = 0;
    await installDemo(page, {
      overrides: {
        "serviceTransfer.importBegin": () => preview,
        "serviceTransfer.setChoices": (input) => {
          const choices = { ...preview.choices, ...(input.choices as object) } as typeof preview.choices & { volumes: string[] };
          const data = preview.data as { volumes: { include: boolean }[] };
          preview = importPreview({ ...preview, choices, data: { ...data, volumes: data.volumes.map((v) => ({ ...v, include: choices.volumes.length > 0 })) } });
          preview = { ...preview, needs: withNeeds(preview) };
          return preview;
        },
        "serviceTransfer.import": () => ({
          service: { id: "svcweb200000000a", projectId: ids.acme, name: "web-2", stopped: true },
          importId: "import0000000001",
          pending: [{ entry: "services/web/volumes/data.tar.gz", sizeBytes: volumeBytes, kind: "volume", volume: "data" }],
          deployTrigger: null,
          skipped: [],
        }),
        "serviceTransfer.getImport": () =>
          receiving([{ path: "services/web/volumes/data.tar.gz", kind: "volume", volume: "data", size: volumeBytes, received }]),
        "serviceTransfer.uploadTicket": (input) => {
          tickets.push(input.offset as number);
          return { url: `/api/transfer/import?t=part-${input.offset}`, ticket: `part-${input.offset}`, expiresAt: new Date(Date.now() + 60_000).toISOString() };
        },
      },
    });
    await page.route("**/api/transfer/import?t=*", async (route) => {
      const size = route.request().postDataBuffer()?.length ?? 0;
      putSizes.push(size);
      // The second part breaks after the panel took 500,000 bytes of it.
      if (puts++ === 1) {
        received = part + 500_000;
        return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "BAD_REQUEST", message: "The part was cut short." } }) });
      }
      received = Math.min(volumeBytes, received + size);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ received, done: received === volumeBytes }) });
    });
    await page.goto(`/import?project=${ids.acme}`);
    await page.getByLabel("Pick a .zip file").setInputFiles({
      name: "web-20261111-1200.seylo.zip",
      mimeType: "application/zip",
      buffer: await exportFile(0, { volumeBytes }),
    });
    await page.getByLabel("Passphrase").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();
    const data = page.getByTestId("import-data");
    const volume = data.getByRole("checkbox", { name: /^data at \/data/ });
    await expect(volume).toBeChecked();
    await expect(data.getByText("which last reported 42.9 GB free")).toBeVisible();
    await expect(page.getByText("1 thing needs you before the import")).toBeVisible();
    await data.getByRole("checkbox", { name: "I checked the size: import this data" }).click();
    await expect(page.getByText("Ready to import.")).toBeVisible();
    await page.getByLabel("New password for admin").fill("a new admin password");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("The upload failed: The part was cut short.")).toBeVisible();
    await expect(page.getByTestId("upload-data")).toContainText("stopped at");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "web-2 is imported" })).toBeVisible();
    // Part 1 from 0, part 2 from 32 MiB (broken), then on from what the panel had.
    expect(tickets).toEqual([0, part, part + 500_000]);
    expect(putSizes).toEqual([part, volumeBytes - part, volumeBytes - part - 500_000]);
  });

  test("a closed import page goes on from the service page with the same file, and refuses another one", async ({ page }) => {
    const zip = await exportFile(0, { volumeBytes: 400_000 });
    const manifest = await manifestSha256(zip);
    const tickets: number[] = [];
    await installDemo(page, {
      overrides: {
        "services.get": () => ({
          ...servicesById[ids.api],
          transfer: {
            kind: "import",
            id: "import0000000001",
            status: "receiving",
            bytes: 100_000,
            totalBytes: 400_000,
            stopped: false,
            volumes: ["data"],
            sha256: null,
            error: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
          },
        }),
        "serviceTransfer.getImport": () =>
          receiving(
            [{ path: "services/web/volumes/data.tar.gz", kind: "volume", volume: "data", size: 400_000, received: tickets.length ? 400_000 : 100_000 }],
            manifest,
          ),
        "serviceTransfer.uploadTicket": (input) => {
          tickets.push(input.offset as number);
          return { url: `/api/transfer/import?t=part-${input.offset}`, ticket: `part-${input.offset}`, expiresAt: new Date(Date.now() + 60_000).toISOString() };
        },
      },
    });
    await page.route("**/api/transfer/import?t=*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ received: 400_000, done: true }) }),
    );
    await page.goto(`/p/${ids.acme}/s/${ids.api}`);
    await expect(page.getByText("api still receives its imported data (100 KB of 400 KB)")).toBeVisible();
    await page.getByRole("link", { name: "Go on with the upload" }).click();
    await expect(page).toHaveURL(/resume=import0000000001/);
    const picker = page.getByLabel("Pick a .zip file");
    await picker.setInputFiles({ name: "other.zip", mimeType: "application/zip", buffer: await exportFile(1000) });
    await expect(page.getByText("This is another file than the one this import began with.")).toBeVisible();
    await picker.setInputFiles({ name: "web.zip", mimeType: "application/zip", buffer: zip });
    await expect(page.getByRole("heading", { name: /is imported/ })).toBeVisible();
    expect(tickets).toEqual([100_000]);
  });
});

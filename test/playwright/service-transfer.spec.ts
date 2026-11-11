// Service export and import on the demo data: the Export card and dialog
// on the Settings tab (owners only, passphrase rules, re-auth, the
// download), and the Import page from the New service menu (reading the
// file in the browser, damaged files, the review choices, basic auth
// passwords, the archive going up in parts with Retry).

import { ids } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { installDemo } from "./demo/routes";
import { exportFile, exportPreview, importPreview, overlapFile, symlinkFile } from "./demo/transfer";
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
    await expect(dialog.getByText("Volume data is not in the file yet: uploads arrive empty.")).toBeVisible();
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
    expect(sent.at(-1)).toEqual({ serviceId: ids.api, secrets: "encrypted", passphrase: "correct horse battery staple", includeSourceLogin: true });
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
            pending: [{ entry: "services/web/source/upload.tar.gz", sizeBytes: 300_000 }],
            deployTrigger: { url: "https://panel.acme.dev/api/hooks/deploy/seylo_hook_demo" },
            skipped: [],
          };
        },
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
});

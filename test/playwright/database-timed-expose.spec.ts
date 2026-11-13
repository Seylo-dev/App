// The timed expose on a database's Connection tab: the open one of the
// Postgres demo database (address, the URL with the password behind the
// eye, psql's command, its own TLS, the countdown, +1 hour adding an hour
// to what is left, Close now), and opening one on Redis from the viewer's
// IP for an hour, which says plainly that the connection is not
// encrypted. Demo data (demo/service.ts exposuresOf) stands in for the
// node; the changes are answered here.
//
// Screenshots: $SHOTS_DIR/database-timed-expose/*.png.

import { mkdirSync } from "node:fs";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { connectionOf, demoDbExpose, exposuresOf, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/database-timed-expose`;
const connection = (serviceId: string) => `/p/${ids.acme}/s/${serviceId}/connection`;

test.describe("database timed expose", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("an open expose shows how to connect, counts down, extends by an hour and closes", async ({ page }) => {
    let extended: Record<string, unknown> | null = null;
    let closed: Record<string, unknown> | null = null;
    // 47 minutes left from now: the demo's own expiresAt counts from when the worker loaded it, which
    // can be minutes before this test when other specs ran first in the same worker.
    const open = { ...demoDbExpose, expiresAt: new Date(Date.now() + 47 * 60_000).toISOString() };
    await installDemo(page, {
      overrides: {
        "exposures.get": (input) =>
          input.serviceId === svc.db ? { ...exposuresOf(svc.db), timed: [open] } : exposuresOf(String(input.serviceId)),
        "exposures.extendTimed": (input) => {
          extended = input;
          return { ...demoDbExpose, expiresAt: new Date(Date.now() + Number(input.durationMinutes) * 60_000).toISOString() };
        },
        "exposures.close": (input) => {
          closed = input;
          return {};
        },
      },
    });
    await page.goto(connection(svc.db));
    const card = page.getByRole("region", { name: "Timed expose" });
    await expect(card.getByText("Open", { exact: true })).toBeVisible();
    await expect(card.getByText("203.0.113.10:47432", { exact: true })).toBeVisible();
    await expect(card.getByText("only from 198.51.100.24")).toBeVisible();
    // The URL carries the password, dots until the eye; copying copies the real one.
    const url = card.getByRole("button", { name: /Connection URL$/ });
    await expect(url).toHaveText("postgresql://postgres:••••••••••••••••@203.0.113.10:47432/shop?sslmode=require");
    await card.getByRole("button", { name: "Show" }).click();
    await expect(url).toHaveText("postgresql://postgres:Zq8vN3pXr7Lm2Kd9@203.0.113.10:47432/shop?sslmode=require");
    await expect(card.getByRole("button", { name: /Command$/ })).toHaveText("psql 'postgresql://postgres@203.0.113.10:47432/shop?sslmode=require'");
    await expect(card.getByText("The command asks for the password, the same as inside.")).toBeVisible();
    // Exposed, so TLS is on in it.
    await expect(card.getByRole("note")).toContainText("Encrypted by PostgreSQL itself");
    // The countdown runs.
    const clock = card.locator("b.font-mono");
    const first = await clock.textContent();
    await expect(clock).not.toHaveText(first ?? "", { timeout: 3000 });
    expect(first).toMatch(/^4[67]:\d\d$/);
    // Below the exposed connection.
    const exposed = await page.getByRole("region", { name: "Exposed connection" }).boundingBox();
    const box = await card.boundingBox();
    expect(box?.y ?? 0).toBeGreaterThan(exposed?.y ?? 0);
    await card.screenshot({ path: `${shots}/postgres-open.png` });
    await page.screenshot({ path: `${shots}/postgres-tab.png`, fullPage: true });

    // +1 hour: an hour on top of the 47 minutes left.
    await card.getByRole("button", { name: "+1 hour" }).click();
    await expect.poll(() => extended).not.toBeNull();
    expect(extended).toMatchObject({ serviceId: svc.db, exposureId: demoDbExpose.id });
    expect(Number((extended as unknown as { durationMinutes: number }).durationMinutes)).toBeGreaterThanOrEqual(106);
    await card.getByRole("button", { name: "Close now" }).click();
    await expect.poll(() => closed).toEqual({ serviceId: svc.db, exposureId: demoDbExpose.id });

    // On a phone the card fits the screen.
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(card.getByText("203.0.113.10:47432", { exact: true })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await card.screenshot({ path: `${shots}/postgres-phone.png` });
  });

  test("Redis opens from my IP for an hour and says the connection is not encrypted", async ({ page }) => {
    let opened: Record<string, unknown> | null = null;
    const redisExpose = {
      ...demoDbExpose,
      id: "e000000000000102",
      serviceId: svc.redis,
      port: 46379,
      targetPort: 6379,
      database: {
        engine: "redis",
        user: "default",
        database: "",
        tls: "none",
        url: "redis://default@203.0.113.10:46379",
        command: "redis-cli -h 203.0.113.10 -p 46379 --askpass",
      },
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    await installDemo(page, {
      overrides: {
        "exposures.openTimed": (input) => {
          opened = input;
          return redisExpose;
        },
        "exposures.get": (input) =>
          opened && input.serviceId === svc.redis ? { ...exposuresOf(svc.redis), timed: [redisExpose] } : exposuresOf(String(input.serviceId)),
        "databases.connection": (input) =>
          input.serviceId === svc.redis && opened
            ? {
                ...connectionOf(svc.redis),
                timed: [{ exposureId: redisExpose.id, host: "203.0.113.10", port: 46379, url: "redis://default:Rk2mV7wTq9Lx4Pb8@203.0.113.10:46379" }],
              }
            : connectionOf(String(input.serviceId)),
      },
    });
    await page.goto(connection(svc.redis));
    const card = page.getByRole("region", { name: "Timed expose" });
    await expect(card.getByText("Closed", { exact: true })).toBeVisible();
    await expect(card).toContainText("Opens redis on de-fsn-1 to your IP for a while");
    await expect(card.getByRole("combobox", { name: "For" })).toHaveText("1 hour");
    await expect(card.getByRole("textbox", { name: "Only from" })).toHaveAttribute("placeholder", "Your IP");
    // One port: no port choice.
    await expect(card.getByRole("combobox", { name: "Port" })).toHaveCount(0);
    await card.screenshot({ path: `${shots}/redis-closed.png` });
    await card.getByRole("button", { name: "Open for 1 hour from my IP" }).click();
    await expect.poll(() => opened).toEqual({ serviceId: svc.redis, targetPort: 6379, durationMinutes: 60 });
    await expect(card.getByText("203.0.113.10:46379", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: /Command$/ })).toHaveText("redis-cli -h 203.0.113.10 -p 46379 --askpass");
    await expect(card.getByRole("note")).toContainText(
      "Not encrypted: Redis has no TLS on this port, so the connection crosses the network in the clear. Only 198.51.100.24 can connect",
    );
    await card.screenshot({ path: `${shots}/redis-open.png` });
  });

  test("ClickHouse offers its HTTP port next to the native one; typed IPs replace mine", async ({ page }) => {
    let opened: Record<string, unknown> | null = null;
    await installDemo(page, {
      overrides: {
        "exposures.openTimed": (input) => {
          opened = input;
          return { ...demoDbExpose, serviceId: svc.clickhouse, targetPort: Number(input.targetPort), port: null, database: null };
        },
      },
    });
    await page.goto(connection(svc.clickhouse));
    const card = page.getByRole("region", { name: "Timed expose" });
    await card.getByRole("combobox", { name: "Port" }).click();
    await page.getByRole("option", { name: "8123, HTTP (JDBC, DBeaver)" }).click();
    await card.getByRole("combobox", { name: "For" }).click();
    await page.getByRole("option", { name: "2 hours" }).click();
    await card.getByRole("textbox", { name: "Only from" }).fill("198.51.100.0/24, 203.0.113.7");
    await card.getByRole("button", { name: "Open for 2 hours" }).click();
    await expect
      .poll(() => opened)
      .toEqual({ serviceId: svc.clickhouse, targetPort: 8123, durationMinutes: 120, allowedCidrs: ["198.51.100.0/24", "203.0.113.7"] });
  });
});

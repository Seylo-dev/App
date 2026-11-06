// Answers the browser's op requests and sockets from the demo data, so every
// screen renders with the boards' data without a fleet behind the panel.
// Order: per-test overrides, then the panel world (fixtures.ts), the
// service screens (service.ts) and the settings screens (settings.ts). Ops
// without demo data go to the real panel the run started (signed in).
// Sockets: the live socket accepts every subscription and streams a few
// deployment log lines; log follow and the terminals answer like an agent.

import type { Page, Route } from "@playwright/test";
import * as world from "./fixtures";
import { handlers as serviceHandlers, logEntries } from "./service";
import { fixtures as settingsFixtures } from "./settings";

type Input = Record<string, any>;
export type Handler = (input: Input) => unknown;

/** The four theme presets of Settings > Appearance (packages/ui/src/styles/theme.css). */
export const presets = ["seylo", "seylo-night", "classic", "midnight"] as const;
export type Preset = (typeof presets)[number];

const worldHandlers: Record<string, Handler> = {
  "auth.whoami": () => ({ viewer: world.viewer, via: "session" }),
  "system.info": () => world.systemInfo,
  "nodes.list": () => ({ nodes: world.nodes }),
  "nodes.get": (input) => world.nodeDetail(String(input.nodeId ?? "")),
  "nodes.healthReport": () => world.healthReport,
  "nodes.listJoinTokens": () => ({ tokens: [] }),
  "nodes.createJoinToken": () => ({
    tokenId: "token00000000001",
    token: "seylo_join_8Kq2fT9xLw4mZp",
    command: "curl -fsSL install.seylo.dev | sh -s -- join seylo_join_8Kq2fT9xLw4mZp",
    expiresAt: new Date(Date.now() + 58 * 60_000).toISOString(),
  }),
  "metrics.nodes": (input) => world.metricsNodes(String(input.range ?? "1h")),
  "metrics.node": (input) => world.metricsNode(String(input.nodeId ?? ""), String(input.range ?? "1h")),
  "projects.list": () => ({ projects: world.projects }),
  "projects.get": (input) => world.projects.find((p) => p.id === input.projectId) ?? world.projects[0],
  "services.list": (input) => ({ services: world.services[String(input.projectId ?? "")] ?? [] }),
  "alerts.list": () => world.alerts,
  "deployments.recent": () => world.recentDeployments,
  "updates.status": () => world.updateStatus,
  "templates.list": (input) => {
    const category = input.category;
    const query = typeof input.query === "string" ? input.query.toLowerCase() : undefined;
    const list = world.templates.templates.filter(
      (t) => (!category || t.category === category) && (!query || t.name.toLowerCase().includes(query)),
    );
    return { templates: list, categories: world.templates.categories };
  },
  "templates.get": () => world.n8nDetail,
  "templates.preview": () => world.n8nPreview,
  "cliLogin.get": (input) => ({
    request: {
      userCode: input.userCode,
      clientName: "build-laptop (darwin/arm64)",
      requestedFrom: "198.51.100.24",
      status: "pending",
      createdAt: new Date(Date.now() - 40_000).toISOString(),
      expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    },
  }),
};

const settingsHandlers: Record<string, Handler> = Object.fromEntries(
  Object.entries(settingsFixtures).map(([id, value]) => [id, typeof value === "function" ? (value as Handler) : () => value]),
);

/** The boot data the web app reads from settings.boot when Vite serves it. */
export function bootFor(preset: Preset, accent: string | null = null) {
  return {
    name: "Seylo",
    productName: "Seylo",
    hidePoweredBy: false,
    loginMessage: "",
    logoLight: null,
    logoDark: null,
    favicon: null,
    preset,
    colorMode: preset === "seylo-night" || preset === "midnight" ? "dark" : "light",
    accent,
    customCss: "",
    revision: `demo-${preset}-${accent ?? "none"}`,
  };
}

function inputOf(route: Route): Input {
  const request = route.request();
  if (request.method() === "GET") {
    const input: Input = {};
    for (const [key, value] of new URL(request.url()).searchParams) input[key] = /^-?\d+$/.test(value) ? Number(value) : value;
    return input;
  }
  try {
    return (request.postDataJSON() as Input | null) ?? {};
  } catch {
    return {};
  }
}

export interface DemoOptions {
  /** Theme preset in settings.boot (the dev server has no injected boot data). */
  preset?: Preset;
  accent?: string | null;
  /** Answers that win over the demo data, for one test. */
  overrides?: Record<string, Handler>;
  /**
   * Holds each demo answer back this many milliseconds (or as many as the
   * function says for an op id), so loading states stay on screen.
   */
  delay?: number | ((opId: string) => number);
}

export async function installDemo(page: Page, options: DemoOptions = {}): Promise<void> {
  const tables: Record<string, Handler>[] = [
    options.overrides ?? {},
    options.preset
      ? {
          "settings.boot": () => bootFor(options.preset as Preset, options.accent ?? null),
          // Appearance previews what is saved: keep it the same as the boot data.
          "settings.appearance": () => {
            const boot = bootFor(options.preset as Preset, options.accent ?? null);
            return { preset: boot.preset, colorMode: boot.colorMode, accent: boot.accent, customCss: "" };
          },
        }
      : {},
    worldHandlers,
    serviceHandlers as Record<string, Handler>,
    settingsHandlers,
  ];
  await page.route(/\/api\/v1\/[a-zA-Z]+\.[a-zA-Z]+/, async (route: Route) => {
    const opId = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const handler = tables.find((table) => table[opId])?.[opId];
    if (!handler) return route.continue();
    const wait = typeof options.delay === "function" ? options.delay(opId) : (options.delay ?? 0);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(handler(inputOf(route))) });
  });
  await installSockets(page);
}

const encode = (text: string) => Buffer.from(text, "utf8");

async function installSockets(page: Page): Promise<void> {
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; topic: string };
      if (message.type !== "subscribe") return;
      ws.send(JSON.stringify({ type: "subscribed", topic: message.topic }));
      // A running deployment keeps printing build lines on its topic.
      if (message.topic.startsWith("deployment:")) {
        let seq = 9;
        const timer = setInterval(() => {
          const line = { seq, ts: new Date().toISOString(), step: "build", text: `#${seq} exporting layer ${seq - 8}`, error: false };
          seq++;
          try {
            ws.send(JSON.stringify({ type: "event", topic: message.topic, event: { type: "log", lines: [line] } }));
          } catch {
            clearInterval(timer);
          }
          if (seq > 14) clearInterval(timer);
        }, 700);
      }
    });
  });
  await page.routeWebSocket(/\/api\/logs/, (ws) => {
    const all = logEntries(2000);
    for (let i = 0; i < all.length; i += 1000) {
      ws.send(JSON.stringify({ type: "entries", entries: all.slice(i, i + 1000).map((e, j) => ({ ...e, generation: i + j > 1000 ? 43 : 42 })) }));
    }
  });
  await page.routeWebSocket(/\/api\/terminal/, (ws) => {
    const shell = /shell|db/.test(ws.url());
    ws.send(JSON.stringify({ type: "ready", containerId: "c0ffee", generation: 42, user: shell ? "bun" : "", workdir: shell ? "/app" : "" }));
    if (shell) ws.send(encode("\x1b[32mbun@api\x1b[0m:\x1b[34m/app\x1b[0m$ "));
    else
      for (const line of [
        "Listening on http://0.0.0.0:3000",
        "GET /v1/cart 200 12ms",
        "POST /v1/checkout 201 84ms",
        "\x1b[33mwarn\x1b[0m: Stripe webhook retry 2/5 for evt_3QxK2m",
        "GET /v1/products?page=2 200 9ms",
      ])
        ws.send(encode(`${line}\r\n`));
    ws.onMessage((message) => {
      if (typeof message === "string") return;
      const text = Buffer.from(message).toString("utf8");
      if (shell) ws.send(encode(text === "\r" ? "\r\nbun.lock  dist  node_modules  package.json  src\r\n\x1b[32mbun@api\x1b[0m:\x1b[34m/app\x1b[0m$ " : text));
      else ws.send(encode("cache hits 92.4% · keys 18,204\r\n"));
    });
  });
}

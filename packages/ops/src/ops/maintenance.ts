// Maintenance and down pages. The global page (Settings) is shown for every
// service unless a service uploads its own. Maintenance mode answers every
// request with the page (503); the down page is shown automatically while a
// service is stopped, deploying for the first time or unreachable.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";

/**
 * A full HTML document; served as is from the node's edge listener with a strict CSP
 * (go/internal/proxy PageContentSecurityPolicy): no scripts or frames, styles, images
 * and fonts inline or over HTTPS.
 */
export const PageHtml = Type.String({ minLength: 1, maxLength: 524288 });

export const Message = Type.String({ maxLength: 500, description: "Short text shown on the default page." });

export const GlobalMaintenance = Type.Object({
  /** Every service shows the maintenance page. */
  enabled: Type.Boolean(),
  message: Type.String(),
  /** Custom page for all services; null uses the built-in page. */
  html: Type.Union([PageHtml, Type.Null()]),
  updatedAt: Type.Union([Timestamp, Type.Null()]),
});

export const ServiceMaintenance = Type.Object({
  serviceId: Id,
  enabled: Type.Boolean(),
  message: Type.String(),
  /** This service's own page; null falls back to the global page. */
  html: Type.Union([PageHtml, Type.Null()]),
  /** Which page visitors get: this service's, the global one, or the built-in default. */
  pageSource: Type.Union([Type.Literal("service"), Type.Literal("global"), Type.Literal("default")]),
  /** Global maintenance is on, so the page shows even with enabled false. */
  globalEnabled: Type.Boolean(),
  updatedAt: Type.Union([Timestamp, Type.Null()]),
});

const serviceScope = (action: `${string}.${string}`) => permission.service(action, (input: { serviceId: string }) => input.serviceId);

export const getGlobal = defineOp({
  id: "maintenance.getGlobal",
  kind: "query",
  summary: "Get the global maintenance page",
  description: "Returns whether panel-wide maintenance mode is on, and the global page shown for services without their own.",
  input: Type.Object({}),
  output: GlobalMaintenance,
  permission: permission.global("settings.view"),
  mcp: true,
  audit: false,
});

export const setGlobal = defineOp({
  id: "maintenance.setGlobal",
  kind: "mutation",
  summary: "Set the global maintenance page",
  description:
    "Turns panel-wide maintenance mode on or off and sets the global page and message. Fields left out keep their value; html null goes back to the built-in page. The Panel project is never put in maintenance. Custom HTML is served with a Content-Security-Policy that blocks scripts and frames; styles, images and fonts load inline or over HTTPS.",
  input: Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    message: Type.Optional(Message),
    html: Type.Optional(Type.Union([PageHtml, Type.Null()])),
  }),
  output: GlobalMaintenance,
  permission: permission.global("settings.edit"),
  mcp: true,
  audit: true,
  // A page of up to 512 Ki characters, escaped as JSON.
  maxBodyBytes: 2 * 1024 * 1024,
});

export const get = defineOp({
  id: "maintenance.get",
  kind: "query",
  summary: "Get a service's maintenance page",
  description: "Returns a service's maintenance mode, its own page if any, and which page visitors actually see.",
  input: Type.Object({ serviceId: Id }),
  output: ServiceMaintenance,
  permission: serviceScope("services.view"),
  mcp: true,
  audit: false,
});

export const set = defineOp({
  id: "maintenance.set",
  kind: "mutation",
  summary: "Set a service's maintenance page",
  description:
    "Turns a service's maintenance mode on or off and sets its own page or message. Fields left out keep their value; html null falls back to the global page. Takes effect on the node right away, without a deploy. The page is also the down page, and custom HTML is served with a Content-Security-Policy that blocks scripts and frames; styles, images and fonts load inline or over HTTPS.",
  input: Type.Object({
    serviceId: Id,
    enabled: Type.Optional(Type.Boolean()),
    message: Type.Optional(Message),
    html: Type.Optional(Type.Union([PageHtml, Type.Null()])),
  }),
  output: ServiceMaintenance,
  permission: serviceScope("services.edit"),
  mcp: true,
  audit: true,
  // A page of up to 512 Ki characters, escaped as JSON.
  maxBodyBytes: 2 * 1024 * 1024,
});

export const preview = defineOp({
  id: "maintenance.preview",
  kind: "query",
  summary: "Preview a maintenance page",
  description:
    "Returns the HTML visitors would see: the service's page when serviceId is given, otherwise the global page, with the message filled in. The web app shows it in a sandboxed frame.",
  input: Type.Object({ serviceId: Type.Optional(Id) }),
  output: Type.Object({ html: Type.String() }),
  // Signed-in is enough to call it; with a serviceId the handler checks services.view on it.
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

// The visitor country request header (X-Seylo-Country): Traefik on every
// node adds the visitor's country (ISO 3166-1 alpha-2, XX when unknown) to
// the requests it sends to apps, from a country database each node keeps
// (DB-IP's IP to Country Lite; MaxMind's GeoLite2 when DB-IP cannot be
// downloaded and an account is set). On by default; services can leave it
// out (services.setCountryHeader).

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id } from "../schemas";

/** The agent capability the header needs, and the first release that has it. */
export const countryHeaderCapability = "routing.country-header.v1";
export const countryHeaderMinAgent = "0.2.24";

/** The request header apps get. */
export const countryHeaderName = "X-Seylo-Country";

/** DB-IP's licence (CC BY 4.0) asks for this credit where the data is used. */
export const countryDataAttribution = { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" } as const;

const MaxMindAccountId = Type.String({ pattern: "^[0-9]{1,12}$", description: "A MaxMind account ID (digits)." });
const MaxMindLicenseKey = Type.String({ pattern: "^[A-Za-z0-9_]{6,128}$", description: "A MaxMind license key." });

export const CountryHeaderSettings = Type.Object({
  /** Apps get the header (services can still leave it out). On unless turned off. */
  enabled: Type.Boolean(),
  /** MaxMind account for GeoLite2 Country, used only when DB-IP's file cannot be downloaded. */
  maxmindAccountId: Type.Union([MaxMindAccountId, Type.Null()]),
  /** Whether a MaxMind license key is stored; the key itself is never returned. */
  maxmindLicenseKeySet: Type.Boolean(),
  /** Every node, and whether its agent adds the header (0.2.24 or later; others only after an update). */
  nodes: Type.Array(Type.Object({ id: Id, name: Type.String(), supported: Type.Boolean() })),
});

const text =
  "Traefik adds X-Seylo-Country (the visitor's country, ISO 3166-1 alpha-2, XX when unknown) to every request it sends to an app, and deletes any X-Seylo-Country (or an alias like X_Seylo_Country) the client sent, so apps can trust it. The country comes from the client's address; for a request from Cloudflare's addresses, the CF-Connecting-IP Cloudflare set. Each node keeps DB-IP's IP to Country Lite database (monthly, no account) in memory; MaxMind's GeoLite2 Country is the fallback when DB-IP cannot be downloaded and a MaxMind account is set. Nodes before 0.2.24 add no header.";

export const get = defineOp({
  id: "countryHeader.get",
  kind: "query",
  summary: "Get the visitor country header setting",
  description: `${text} Returns whether it is on, whether a MaxMind account is set (never the key) and which nodes support it.`,
  input: Type.Object({}),
  output: CountryHeaderSettings,
  permission: permission.global("settings.view"),
  mcp: true,
  audit: false,
});

export const update = defineOp({
  id: "countryHeader.update",
  kind: "mutation",
  summary: "Turn the visitor country header on or off, or set a MaxMind account",
  description: `${text} Omitted fields keep their value; null removes the MaxMind account ID or license key. Nodes apply it within seconds. Off: nodes stop the lookup and only delete what clients send.`,
  input: Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    maxmindAccountId: Type.Optional(Type.Union([MaxMindAccountId, Type.Null()])),
    maxmindLicenseKey: Type.Optional(Type.Union([MaxMindLicenseKey, Type.Null()])),
  }),
  output: CountryHeaderSettings,
  sensitive: { input: ["maxmindLicenseKey"] },
  permission: permission.global("settings.manage"),
  mcp: true,
  audit: true,
});

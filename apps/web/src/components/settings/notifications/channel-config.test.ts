import { expect, test } from "bun:test";
import { buildChannelConfig, emptyForm, formFromView } from "./channel-config";

test("smtp needs host, from and recipients, and splits the recipient list", () => {
  const result = buildChannelConfig("smtp", {
    ...emptyForm,
    host: "smtp.example.com",
    port: "465",
    security: "tls",
    username: "alerts@example.com",
    password: "secret",
    from: "alerts@example.com",
    to: "ops@example.com, me@example.com",
  });
  expect(result).toEqual({
    ok: true,
    config: {
      kind: "smtp",
      host: "smtp.example.com",
      port: 465,
      security: "tls",
      username: "alerts@example.com",
      password: "secret",
      from: "alerts@example.com",
      to: ["ops@example.com", "me@example.com"],
    },
  });
  const bad = buildChannelConfig("smtp", { ...emptyForm, port: "70000", to: "not-an-email" });
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.errors.map((e) => e.field).sort()).toEqual(["from", "host", "port", "to"]);
});

test("a missing secret is required on create but kept when one is stored", () => {
  const create = buildChannelConfig("discord", emptyForm);
  expect(create).toEqual({ ok: false, errors: [{ field: "webhookUrl", problem: "required" }] });
  const edit = buildChannelConfig("discord", emptyForm, ["webhookUrl"]);
  expect(edit).toEqual({ ok: true, config: { kind: "discord" } });
});

test("ntfy validates the topic and leaves out an empty server", () => {
  expect(buildChannelConfig("ntfy", { ...emptyForm, topic: "seylo-alerts" })).toEqual({
    ok: true,
    config: { kind: "ntfy", topic: "seylo-alerts" },
  });
  const bad = buildChannelConfig("ntfy", { ...emptyForm, topic: "bad topic", serverUrl: "ftp://x" });
  expect(bad.ok).toBe(false);
});

test("webhook urls must be http(s)", () => {
  expect(buildChannelConfig("webhook", { ...emptyForm, url: "javascript:alert(1)" }).ok).toBe(false);
  expect(buildChannelConfig("webhook", { ...emptyForm, url: "https://n8n.example.com/hook", signingSecret: "s" })).toEqual({
    ok: true,
    config: { kind: "webhook", url: "https://n8n.example.com/hook", signingSecret: "s" },
  });
});

test("formFromView round-trips the non-secret fields", () => {
  const form = formFromView({
    kind: "smtp",
    host: "h",
    port: 25,
    security: "none",
    username: "u",
    from: "a@b.co",
    to: ["c@d.co", "e@f.co"],
  });
  expect(form.to).toBe("c@d.co, e@f.co");
  expect(form.password).toBe("");
  expect(buildChannelConfig("smtp", form, ["password"])).toEqual({
    ok: true,
    config: { kind: "smtp", host: "h", port: 25, security: "none", username: "u", from: "a@b.co", to: ["c@d.co", "e@f.co"] },
  });
});

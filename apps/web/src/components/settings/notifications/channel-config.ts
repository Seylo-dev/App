// Turns the channel form's text fields into the ChannelConfigInput the
// notifications ops take, and back. Secret fields are write-only: when
// editing, an empty secret means "keep the stored one", so it is left out.

import type { notifications } from "@seylo/ops";

export type ChannelKind = (typeof notifications.channelKinds)[number];
export type ChannelConfig = notifications.ChannelConfigInput;
type View = notifications.Channel["config"];

/** Every field the form can show, as text. */
export interface ChannelForm {
  host: string;
  port: string;
  security: "starttls" | "tls" | "none";
  username: string;
  password: string;
  from: string;
  to: string;
  url: string;
  signingSecret: string;
  webhookUrl: string;
  botToken: string;
  chatId: string;
  serverUrl: string;
  topic: string;
  accessToken: string;
  userKey: string;
  appToken: string;
}

export const emptyForm: ChannelForm = {
  host: "",
  port: "587",
  security: "starttls",
  username: "",
  password: "",
  from: "",
  to: "",
  url: "",
  signingSecret: "",
  webhookUrl: "",
  botToken: "",
  chatId: "",
  serverUrl: "",
  topic: "",
  accessToken: "",
  userKey: "",
  appToken: "",
};

/** Secret fields each kind needs on create; on edit they may stay empty. */
export const requiredSecrets: Record<ChannelKind, (keyof ChannelForm)[]> = {
  smtp: [],
  webhook: [],
  discord: ["webhookUrl"],
  slack: ["webhookUrl"],
  telegram: ["botToken"],
  ntfy: [],
  pushover: ["userKey", "appToken"],
  gotify: ["appToken"],
};

/** Fills the form from a saved channel (secrets stay empty). */
export function formFromView(view: View): ChannelForm {
  const form = { ...emptyForm };
  switch (view.kind) {
    case "smtp":
      return {
        ...form,
        host: view.host,
        port: String(view.port),
        security: view.security,
        username: view.username,
        from: view.from,
        to: view.to.join(", "),
      };
    case "webhook":
      return { ...form, url: view.url };
    case "telegram":
      return { ...form, chatId: view.chatId };
    case "ntfy":
      return { ...form, serverUrl: view.serverUrl, topic: view.topic };
    case "gotify":
      return { ...form, serverUrl: view.serverUrl };
    default:
      return form;
  }
}

export type FieldError = { field: keyof ChannelForm; problem: "required" | "invalid" };
export type BuildResult = { ok: true; config: ChannelConfig } | { ok: false; errors: FieldError[] };

const emailPattern = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const httpPattern = /^https?:\/\/\S+$/;
const topicPattern = /^[A-Za-z0-9_-]+$/;

/**
 * Builds the config for a kind. `editing` lists secret fields already
 * stored, which may stay empty (omitted, so the panel keeps them).
 */
export function buildChannelConfig(kind: ChannelKind, form: ChannelForm, storedSecrets: readonly string[] = []): BuildResult {
  const errors: FieldError[] = [];
  const v = (field: keyof ChannelForm) => form[field].trim();
  const need = (field: keyof ChannelForm) => {
    if (!v(field)) errors.push({ field, problem: "required" });
  };
  const url = (field: keyof ChannelForm, required: boolean) => {
    if (!v(field)) {
      if (required) errors.push({ field, problem: "required" });
    } else if (!httpPattern.test(v(field))) errors.push({ field, problem: "invalid" });
  };
  /** A secret: required on create, optional when one is stored. Returns the value to send, or undefined to keep. */
  const secret = (field: keyof ChannelForm) => {
    const value = v(field);
    if (!value && requiredSecrets[kind].includes(field) && !storedSecrets.includes(field)) errors.push({ field, problem: "required" });
    return value || undefined;
  };
  const opt = <K extends string, T>(key: K, value: T | undefined) => (value === undefined ? {} : ({ [key]: value } as Record<K, T>));

  let config: ChannelConfig | null = null;
  switch (kind) {
    case "smtp": {
      need("host");
      const port = Number(v("port"));
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push({ field: "port", problem: "invalid" });
      if (!emailPattern.test(v("from"))) errors.push({ field: "from", problem: v("from") ? "invalid" : "required" });
      const to = v("to")
        .split(/[,\s]+/)
        .filter(Boolean);
      if (to.length === 0) errors.push({ field: "to", problem: "required" });
      else if (to.some((address) => !emailPattern.test(address)) || to.length > 20) errors.push({ field: "to", problem: "invalid" });
      config = {
        kind,
        host: v("host"),
        port,
        security: form.security,
        username: v("username"),
        ...opt("password", secret("password")),
        from: v("from"),
        to,
      };
      break;
    }
    case "webhook":
      url("url", true);
      config = { kind, url: v("url"), ...opt("signingSecret", secret("signingSecret")) };
      break;
    case "discord":
    case "slack": {
      const hook = secret("webhookUrl");
      if (hook && !httpPattern.test(hook)) errors.push({ field: "webhookUrl", problem: "invalid" });
      config = { kind, ...opt("webhookUrl", hook) };
      break;
    }
    case "telegram":
      need("chatId");
      config = { kind, ...opt("botToken", secret("botToken")), chatId: v("chatId") };
      break;
    case "ntfy":
      url("serverUrl", false);
      need("topic");
      if (v("topic") && !topicPattern.test(v("topic"))) errors.push({ field: "topic", problem: "invalid" });
      config = { kind, ...opt("serverUrl", v("serverUrl") || undefined), topic: v("topic"), ...opt("accessToken", secret("accessToken")) };
      break;
    case "pushover":
      config = { kind, ...opt("userKey", secret("userKey")), ...opt("appToken", secret("appToken")) };
      break;
    case "gotify":
      url("serverUrl", true);
      config = { kind, serverUrl: v("serverUrl"), ...opt("appToken", secret("appToken")) };
      break;
  }
  return errors.length > 0 || !config ? { ok: false, errors } : { ok: true, config };
}

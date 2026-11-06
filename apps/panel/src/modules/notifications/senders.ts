// Delivers one notification to one channel. Every kind formats the same
// Notice for its service (Discord embed, Slack blocks, Telegram HTML, ...).
// Errors are short and safe to show: they never contain the channel's URL
// or token, only what the receiving service answered.

import { createHmac } from "node:crypto";
import { slug } from "@seylo/brand";
import type { notifications as notificationOps } from "@seylo/ops";
import { createTransport } from "nodemailer";

/** A channel config with its secrets filled in. */
export type ChannelConfig = notificationOps.ChannelConfigInput;

export interface Notice {
  /** "alert" for real alerts, "test" for the send-test button. */
  type: "alert" | "test";
  event: string;
  severity: "error" | "warning" | "info" | "ok";
  title: string;
  message: string;
  /** Absolute URL into the panel, or null. */
  link: string | null;
  panelName: string;
  panelUrl: string;
  at: Date;
  alertId: string | null;
  projectId: string | null;
  serviceId: string | null;
  nodeId: string | null;
}

export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

export interface SmtpTransport {
  sendMail(message: MailMessage): Promise<unknown>;
  close?(): void;
}

/** What senders use to reach the outside; tests swap it. */
export interface NotifyIo {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  smtp: (config: Extract<ChannelConfig, { kind: "smtp" }>) => SmtpTransport;
  /** Per request, in milliseconds. */
  timeoutMs: number;
}

export const defaultNotifyIo: NotifyIo = {
  fetch: (input, init) => fetch(input, init),
  smtp: (config) =>
    createTransport({
      host: config.host,
      port: config.port,
      secure: config.security === "tls",
      requireTLS: config.security === "starttls",
      ignoreTLS: config.security === "none",
      auth: config.username ? { user: config.username, pass: config.password ?? "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    }) as unknown as SmtpTransport,
  timeoutMs: 10_000,
};

let activeIo: NotifyIo = defaultNotifyIo;

/** The io deliveries use; tests point it at fakes and back with resetNotifyIo(). */
export function getNotifyIo(): NotifyIo {
  return activeIo;
}

export function setNotifyIo(io: Partial<NotifyIo>): void {
  activeIo = { ...defaultNotifyIo, ...io };
}

export function resetNotifyIo(): void {
  activeIo = defaultNotifyIo;
}

export class DeliveryError extends Error {
  override name = "DeliveryError";
}

const severityColor: Record<Notice["severity"], number> = { error: 0xdc2626, warning: 0xd97706, info: 0x2563eb, ok: 0x16a34a };
const severityLabel: Record<Notice["severity"], string> = { error: "Error", warning: "Warning", info: "Info", ok: "Resolved" };

/** Signature header of webhook channels: "sha256=<hex HMAC of `${timestamp}.${body}`>". */
export const webhookSignatureHeader = `x-${slug}-signature`;
export const webhookTimestampHeader = `x-${slug}-timestamp`;

export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function subjectLine(notice: Notice): string {
  return notice.type === "test" ? `[${notice.panelName}] Test notification` : `[${notice.panelName}] ${notice.title}`;
}

export function plainText(notice: Notice): string {
  const lines = [notice.title];
  if (notice.message) lines.push(notice.message);
  if (notice.link) lines.push(notice.link);
  lines.push(`${notice.panelName} - ${notice.at.toISOString()}`);
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Slack mrkdwn needs &, < and > escaped; everything else is literal. */
function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The JSON body every webhook channel receives. Documented, so keep it stable. */
export function webhookBody(notice: Notice) {
  return {
    type: notice.type,
    event: notice.event,
    severity: notice.severity,
    title: notice.title,
    message: notice.message,
    link: notice.link,
    alertId: notice.alertId,
    projectId: notice.projectId,
    serviceId: notice.serviceId,
    nodeId: notice.nodeId,
    panel: { name: notice.panelName, url: notice.panelUrl },
    createdAt: notice.at.toISOString(),
  };
}

export function discordBody(notice: Notice) {
  return {
    username: notice.panelName.slice(0, 80),
    embeds: [
      {
        title: notice.title.slice(0, 256),
        description: notice.message.slice(0, 4000),
        color: severityColor[notice.severity],
        ...(notice.link ? { url: notice.link } : {}),
        timestamp: notice.at.toISOString(),
        footer: { text: notice.panelName.slice(0, 2048) },
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function slackBody(notice: Notice) {
  const head = `*${severityLabel[notice.severity]}: ${escapeSlack(notice.title)}*`;
  const body = notice.message ? `\n${escapeSlack(notice.message)}` : "";
  const link = notice.link ? `\n<${notice.link}|Open in ${escapeSlack(notice.panelName)}>` : "";
  return {
    text: `${notice.title}${notice.message ? ` - ${notice.message}` : ""}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${head}${body}${link}`.slice(0, 3000) } },
      { type: "context", elements: [{ type: "mrkdwn", text: `${escapeSlack(notice.panelName)} · ${notice.at.toISOString()}` }] },
    ],
  };
}

export function telegramBody(notice: Notice, chatId: string) {
  const parts = [`<b>${severityLabel[notice.severity]}: ${escapeHtml(notice.title)}</b>`];
  if (notice.message) parts.push(escapeHtml(notice.message));
  if (notice.link) parts.push(`<a href="${escapeHtml(notice.link)}">Open in ${escapeHtml(notice.panelName)}</a>`);
  return { chat_id: chatId, text: parts.join("\n").slice(0, 4096), parse_mode: "HTML", disable_web_page_preview: true };
}

const ntfyPriority: Record<Notice["severity"], number> = { error: 5, warning: 4, info: 3, ok: 3 };
const ntfyTags: Record<Notice["severity"], string> = {
  error: "rotating_light",
  warning: "warning",
  info: "information_source",
  ok: "white_check_mark",
};

export function ntfyBody(notice: Notice, topic: string) {
  return {
    topic,
    title: notice.title,
    message: notice.message || notice.title,
    priority: ntfyPriority[notice.severity],
    tags: [ntfyTags[notice.severity]],
    ...(notice.link ? { click: notice.link } : {}),
  };
}

const pushoverPriority: Record<Notice["severity"], string> = { error: "1", warning: "0", info: "0", ok: "-1" };

export function pushoverForm(notice: Notice, appToken: string, userKey: string): URLSearchParams {
  const form = new URLSearchParams({
    token: appToken,
    user: userKey,
    title: notice.title.slice(0, 250),
    message: (notice.message || notice.title).slice(0, 1024),
    priority: pushoverPriority[notice.severity],
  });
  if (notice.link) {
    form.set("url", notice.link);
    form.set("url_title", `Open in ${notice.panelName}`.slice(0, 100));
  }
  return form;
}

const gotifyPriority: Record<Notice["severity"], number> = { error: 8, warning: 5, info: 3, ok: 2 };

export function gotifyBody(notice: Notice) {
  return {
    title: notice.title,
    message: notice.message || notice.title,
    priority: gotifyPriority[notice.severity],
    ...(notice.link ? { extras: { "client::notification": { click: { url: notice.link } } } } : {}),
  };
}

export function emailMessage(notice: Notice, from: string, to: string[]): MailMessage {
  const linkHtml = notice.link ? `<p><a href="${escapeHtml(notice.link)}">Open in ${escapeHtml(notice.panelName)}</a></p>` : "";
  return {
    from,
    to,
    subject: subjectLine(notice),
    text: plainText(notice),
    html:
      `<p><strong>${escapeHtml(notice.title)}</strong></p>` +
      (notice.message ? `<p>${escapeHtml(notice.message)}</p>` : "") +
      linkHtml +
      `<p style="color:#64748b;font-size:12px">${escapeHtml(notice.panelName)} - ${notice.at.toISOString()}</p>`,
  };
}

function need(value: string | undefined, field: string): string {
  if (!value) throw new DeliveryError(`The channel has no ${field}. Edit the channel and set it.`);
  return value;
}

/** Sends a notice; throws DeliveryError with a safe message when the receiver refused it. */
export async function deliver(config: ChannelConfig, notice: Notice, io: NotifyIo = getNotifyIo()): Promise<void> {
  switch (config.kind) {
    case "smtp": {
      const transport = io.smtp(config);
      try {
        await withTimeout(transport.sendMail(emailMessage(notice, config.from, config.to)), io.timeoutMs * 3, "The mail server");
      } catch (error) {
        if (error instanceof DeliveryError) throw error;
        throw new DeliveryError(`The mail server refused the message: ${smtpReason(error)}`);
      } finally {
        transport.close?.();
      }
      return;
    }
    case "webhook": {
      const body = JSON.stringify(webhookBody(notice));
      const timestamp = String(Math.floor(notice.at.getTime() / 1000));
      const headers: Record<string, string> = { "content-type": "application/json", [webhookTimestampHeader]: timestamp };
      if (config.signingSecret) headers[webhookSignatureHeader] = webhookSignature(config.signingSecret, timestamp, body);
      await post(io, config.url, { headers, body }, "The webhook");
      return;
    }
    case "discord":
      await post(io, need(config.webhookUrl, "webhook URL"), json(discordBody(notice)), "Discord");
      return;
    case "slack":
      await post(io, need(config.webhookUrl, "webhook URL"), json(slackBody(notice)), "Slack");
      return;
    case "telegram": {
      const token = need(config.botToken, "bot token");
      await post(io, `https://api.telegram.org/bot${token}/sendMessage`, json(telegramBody(notice, config.chatId)), "Telegram");
      return;
    }
    case "ntfy": {
      const server = (config.serverUrl || "https://ntfy.sh").replace(/\/+$/, "");
      const init = json(ntfyBody(notice, config.topic));
      if (config.accessToken) init.headers.authorization = `Bearer ${config.accessToken}`;
      await post(io, `${server}/`, init, "ntfy");
      return;
    }
    case "pushover": {
      const form = pushoverForm(notice, need(config.appToken, "app token"), need(config.userKey, "user key"));
      await post(
        io,
        "https://api.pushover.net/1/messages.json",
        { headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
        "Pushover",
      );
      return;
    }
    case "gotify": {
      const init = json(gotifyBody(notice));
      init.headers["x-gotify-key"] = need(config.appToken, "app token");
      await post(io, `${config.serverUrl.replace(/\/+$/, "")}/message`, init, "Gotify");
      return;
    }
  }
}

function json(value: unknown): { headers: Record<string, string>; body: string } {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

async function post(io: NotifyIo, url: string, init: { headers: Record<string, string>; body: string }, who: string): Promise<void> {
  let response: Response;
  try {
    response = await io.fetch(url, {
      method: "POST",
      headers: { "user-agent": `${slug}-panel`, ...init.headers },
      body: init.body,
      redirect: "error",
      signal: AbortSignal.timeout(io.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new DeliveryError(timedOut ? `${who} did not answer within ${io.timeoutMs / 1000} seconds.` : `Could not reach ${who}.`);
  }
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
  throw new DeliveryError(`${who} answered ${response.status}${text ? `: ${scrub(text)}` : "."}`);
}

/** Receivers sometimes echo the URL or token back; keep anything that looks like one out of the message. */
function scrub(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "[url]").replace(/bot\d+:[\w-]+/g, "bot[token]");
}

function smtpReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrub(message.replace(/\s+/g, " ").slice(0, 200));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, who: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeliveryError(`${who} did not answer within ${Math.round(ms / 1000)} seconds.`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

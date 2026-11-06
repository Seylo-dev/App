// deps.notify: plain emails (invite links, ...) through the panel's SMTP
// channel. The default channel is used when it is SMTP; otherwise the
// oldest enabled SMTP channel. Without one the caller shows a link to copy.

import { and, asc, desc, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { notificationChannels } from "../../db/schema";
import type { Logger } from "../../logger";
import type { SecretBox } from "../../security/secret-box";
import { openConfig } from "./channels";
import { DeliveryError, getNotifyIo } from "./senders";

export interface PlainEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailOutcome = "sent" | "noChannel" | "failed";

export interface Notifier {
  /** Never throws; "failed" is logged with the reason. */
  sendEmail(email: PlainEmail): Promise<EmailOutcome>;
}

export function createNotifier(parts: { db: PanelDb; secrets: SecretBox; logger: Logger }): Notifier {
  return {
    async sendEmail(email) {
      const row = parts.db
        .select()
        .from(notificationChannels)
        .where(and(eq(notificationChannels.kind, "smtp"), eq(notificationChannels.enabled, true)))
        .orderBy(desc(notificationChannels.isDefault), asc(notificationChannels.createdAt))
        .limit(1)
        .get();
      if (!row) return "noChannel";
      try {
        const config = openConfig(parts.secrets, row);
        if (config.kind !== "smtp") return "noChannel";
        const io = getNotifyIo();
        const transport = io.smtp(config);
        try {
          await transport.sendMail({ from: config.from, to: [email.to], subject: email.subject, text: email.text, html: email.html });
        } finally {
          transport.close?.();
        }
        return "sent";
      } catch (error) {
        const reason = error instanceof DeliveryError ? error.message : error instanceof Error ? error.message.slice(0, 200) : "unknown";
        parts.logger.warn({ channelId: row.id, reason }, "sending an email failed");
        return "failed";
      }
    },
  };
}

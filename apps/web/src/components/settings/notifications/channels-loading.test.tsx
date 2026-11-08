import { expect, test } from "bun:test";
import { auth } from "@seylo/ops";
import type { ComponentType } from "react";
import { Route } from "../../../routes/_app/settings/notifications";
import { renderStatic } from "../../../test/render";

const NotificationsPage = Route.options.component as ComponentType;
const owner = [auth.whoami, {}, { viewer: { id: "u1", email: "a@example.com", name: "Ada", role: "owner" }, via: "session" }] as const;

/** The markup of the channels region. */
const channels = (out: string) => out.slice(out.indexOf('aria-label="Channels"'), out.indexOf('id="channel-form"'));

test("while the channels load they show placeholder cards shaped like a channel card", async () => {
  const region = channels(await renderStatic(() => <NotificationsPage />, [[...owner]]));
  // Before: one blank white card pulsing with animate-pulse, no shimmer and no busy region.
  expect(region).not.toContain("animate-pulse");
  expect(region).toContain('role="status"');
  expect(region).toContain('aria-busy="true"');
  const cards = region.split('data-slot="card"').length - 1;
  expect(cards).toBe(2);
  // Each has the kind chip, the name, the two buttons an editor sees, the target and the usage line.
  expect(region.split('data-slot="skeleton"').length - 1).toBe(cards * 6);
});

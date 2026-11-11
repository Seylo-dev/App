import { expect, test } from "bun:test";
import { renderStatic } from "../../test/render";
import { PanelMoveBannerView } from "../shell/panel-move-banner";
import {
  type MoveCheck,
  MovedAway,
  MoveFailed,
  MoveFormView,
  MoveLost,
  MoveProgress,
  MoveResult,
  type MoveStatus,
  moveProgress,
  showsFailure,
  targetLabel,
} from "./panel-move-card";

const ids = { old: "oldnode000000001", fresh: "newnode000000002", b: "bnode00000000003" };

const status = (over: Partial<MoveStatus> = {}): MoveStatus => ({
  state: "idle",
  side: null,
  moveId: null,
  targetNodeId: null,
  targetNodeName: null,
  targetAddress: null,
  newUrl: null,
  step: null,
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: null,
  error: null,
  leftBehind: [],
  doneAt: null,
  fromNodeId: null,
  fromNodeName: null,
  oldCopyRemoved: false,
  domain: null,
  canCancel: false,
  waitingSince: null,
  canForceCancel: false,
  oldPanelRunning: false,
  ...over,
});

const moving = (over: Partial<MoveStatus> = {}) =>
  status({
    state: "running",
    moveId: "move000000000001",
    targetNodeId: ids.fresh,
    targetNodeName: "de-fsn-2",
    targetAddress: "203.0.113.20",
    newUrl: "http://203.0.113.20:3000",
    fromNodeId: ids.old,
    fromNodeName: "de-fsn-1",
    startedAt: new Date().toISOString(),
    canCancel: true,
    ...over,
  });

const check = (over: Partial<MoveCheck> = {}): MoveCheck => ({
  blocks: [],
  targets: [
    { id: ids.fresh, name: "de-fsn-2", online: true, address: "203.0.113.20", ready: true, blocks: [] },
    {
      id: ids.old,
      name: "de-fsn-1",
      online: true,
      address: "203.0.113.10",
      ready: false,
      blocks: [{ code: "targetIsPanel", message: "The panel runs on de-fsn-1 already.", soft: false }],
    },
  ],
  targetNodeId: ids.fresh,
  defaultAddress: "203.0.113.20",
  nodesToMove: [
    { id: ids.fresh, name: "de-fsn-2" },
    { id: ids.old, name: "de-fsn-1" },
  ],
  nodesLeftBehind: [],
  warnings: [{ code: "ipUrl", message: "The panel answers at http://203.0.113.20:3000 afterwards." }],
  domain: null,
  agentPort: 3443,
  fromNode: { id: ids.old, name: "de-fsn-1" },
  ...over,
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** The Move the panel button's disabled attribute, as rendered. */
const startButton = (html: string) =>
  (/<button([^>]*)>Move the panel<\/button>/.exec(html)?.[1] ?? "").includes(' disabled=""') ? "disabled" : "enabled";

test("ready: the node, its address prefilled, who follows, the warning and an enabled Start", async () => {
  const html = await renderStatic(() => <MoveFormView check={check()} target={ids.fresh} onTarget={() => {}} />);
  const out = text(html);
  expect(out).toContain("Everything moves: the database, the master key");
  expect(out).toContain("Nodes connect to https://203.0.113.20:3443.");
  expect(html).toContain('value="203.0.113.20"');
  expect(out).toContain("2 nodes follow on their own: de-fsn-2 and de-fsn-1.");
  expect(out).toContain("The panel answers at http://203.0.113.20:3000 afterwards.");
  expect(startButton(html)).not.toContain("disabled");
});

test("blocked: the panel's reasons in a list and Start stays off", async () => {
  const blocked = check({
    blocks: [{ code: "workRunning", message: "1 deployment is queued or running. Try again once it finished.", soft: false }],
  });
  const html = await renderStatic(() => <MoveFormView check={blocked} target={ids.fresh} onTarget={() => {}} />);
  expect(text(html)).toContain("Can't move the panel yet");
  expect(text(html)).toContain("1 deployment is queued or running.");
  expect(startButton(html)).toContain("disabled");
  // Before a node is picked the address waits and Start is off.
  const none = await renderStatic(() => (
    <MoveFormView check={check({ targetNodeId: null, defaultAddress: null })} target={null} onTarget={() => {}} />
  ));
  expect(none).not.toContain('value="203.0.113.20"');
  expect(startButton(none)).toContain("disabled");
});

test("nodes that cannot follow: listed with why, and Start waits for the tick", async () => {
  const left = check({
    nodesLeftBehind: [{ id: ids.b, name: "us-east-1", reason: "plainHttp" }],
    blocks: [{ code: "nodesLeftBehind", message: "us-east-1 connects over plain http://", soft: true, nodeIds: [ids.b] }],
  });
  const html = await renderStatic(() => <MoveFormView check={left} target={ids.fresh} onTarget={() => {}} />);
  const out = text(html);
  expect(out).toContain("These nodes cannot follow");
  expect(out).toContain("us-east-1: connects over plain http://");
  expect(out).toContain("I will join these again with seylo join --force afterwards");
  // A soft block is not in the refusal list.
  expect(out).not.toContain("Can't move the panel yet");
  expect(startButton(html)).toContain("disabled");
});

test("moving: every step with the current one, the bytes, and Cancel until the switch", async () => {
  const shipping = moving({ step: "shipping", bytesDone: 5 * 1024 * 1024, bytesTotal: 20 * 1024 * 1024 });
  const html = await renderStatic(() => <MoveProgress status={shipping} />);
  const out = text(html);
  expect(out).toContain("Moving the panel to de-fsn-2");
  expect(out).toContain("Read-only until it is done.");
  expect(out).toContain("Copying the image registry");
  expect(html).toMatch(/aria-current="step"[^>]*>.*Sending the copy to de-fsn-2/s);
  expect(out).toContain("5 MB of 20 MB");
  expect(out).toContain("Cancel the move");
  expect(moveProgress(shipping)).toBe(Math.round(((3 + 0.25) / 7) * 100));
  const switching = await renderStatic(() => <MoveProgress status={moving({ step: "switching", canCancel: false })} />);
  expect(text(switching)).not.toContain("Cancel the move");
});

test("failed: where it stopped, why, nothing changed, Try again", async () => {
  const failed = status({
    state: "failed",
    targetNodeName: "de-fsn-2",
    step: "staging",
    error: { step: "staging", message: "us-east-1 could not reach the moved panel at https://203.0.113.20:3443." },
  });
  const out = text(await renderStatic(() => <MoveFailed status={failed} onRetry={() => {}} />));
  expect(out).toContain("The move to de-fsn-2 stopped");
  expect(out).toContain("us-east-1 could not reach the moved panel");
  expect(out).toContain("At: Telling every node the new address.");
  expect(out).toContain("Nothing changed: the panel runs here as before.");
  expect(out).toContain("Try again");
});

test("done on the moved panel: the new address, the DNS record, who to join again, Delete the old copy", async () => {
  const done = moving({
    state: "done",
    side: "new",
    step: null,
    canCancel: false,
    domain: "panel.acme.dev",
    leftBehind: [{ id: ids.b, name: "us-east-1" }],
    doneAt: new Date().toISOString(),
  });
  const out = text(await renderStatic(() => <MoveResult status={done} />));
  expect(out).toContain("The panel moved to de-fsn-2");
  expect(out).toContain("It answers at http://203.0.113.20:3000.");
  expect(out).toContain("seylo login http://203.0.113.20:3000");
  expect(out).toContain("Point the DNS record of panel.acme.dev at 203.0.113.20.");
  expect(out).toContain("with --force on each: us-east-1.");
  expect(out).toContain("The old copy of the panel is still on de-fsn-1, stopped.");
  expect(out).toContain("Delete the old copy");
  const gone = text(await renderStatic(() => <MoveResult status={{ ...done, oldCopyRemoved: true }} />));
  expect(gone).toContain("The old copy on de-fsn-1 is deleted.");
  expect(gone).not.toContain("is still on de-fsn-1");
  const running = text(await renderStatic(() => <MoveResult status={{ ...done, oldPanelRunning: true }} />));
  expect(running).toContain("de-fsn-1 did not confirm that the old panel stopped.");
});

/** The hrefs of the links in rendered markup, in order. */
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);

test("the old copy says where the panel is now", async () => {
  const old = moving({ state: "done", side: "old", step: "switching", canCancel: false });
  const html = await renderStatic(() => <MovedAway status={old} />);
  expect(text(html)).toContain("The panel moved to de-fsn-2");
  expect(text(html)).toContain("This is the old copy.");
  expect(hrefs(html)).toEqual(["http://203.0.113.20:3000"]);
});

test("the old copy with a domain: Open goes to the new IP address, the domain only once its DNS points there", async () => {
  const old = moving({ state: "done", side: "old", step: "switching", canCancel: false, domain: "panel.acme.dev" });
  const html = await renderStatic(() => <MovedAway status={old} />);
  // The domain's record still points at this server right after the move.
  expect(/<a [^>]*href="http:\/\/203\.0\.113\.20:3000"[^>]*>Open http:\/\/203\.0\.113\.20:3000/.test(html)).toBe(true);
  expect(hrefs(html).sort()).toEqual(["http://203.0.113.20:3000", "https://panel.acme.dev"]);
  expect(text(html)).toContain("panel.acme.dev works too once its DNS record points at 203.0.113.20.");
  const banner = await renderStatic(() => <PanelMoveBannerView status={old} />);
  expect(text(banner)).toContain("panel.acme.dev works once its DNS record points at the new server");
  expect(/<a [^>]*href="http:\/\/203\.0\.113\.20:3000"[^>]*>Open it/.test(banner)).toBe(true);
  expect(hrefs(banner).sort()).toEqual(["http://203.0.113.20:3000", "https://panel.acme.dev"]);
});

test("a page that only saw the old panel stop answering at the end says where the panel went", async () => {
  const lost = moving({ state: "done", side: "old", step: "switching", canCancel: false });
  const out = text(await renderStatic(() => <MovedAway status={lost} lost />));
  expect(out).toContain("The panel moved to de-fsn-2");
  expect(out).toContain("The old server stopped answering at the last step of the move");
  expect(out).toContain("Open http://203.0.113.20:3000");
});

test("a page that saw the old panel stop answering before the switch: the new address if the move finished, and Try again", async () => {
  const shipping = moving({ step: "shipping" });
  const html = await renderStatic(() => <MoveLost status={shipping} onRetry={() => {}} />);
  const out = text(html);
  expect(out).toContain("This server stopped answering during the move to de-fsn-2");
  expect(out).toContain("If the move finished, the panel is at its new address now.");
  expect(out).toContain("Try again");
  expect(hrefs(html)).toEqual(["http://203.0.113.20:3000"]);
  // Not the firm words of a move past the switch.
  expect(out).not.toContain("The panel moved to");
  const banner = await renderStatic(() => <PanelMoveBannerView status={shipping} lost />);
  expect(text(banner)).toContain(
    "This server stopped answering while the panel moved to de-fsn-2. If the move finished, the panel is there now.",
  );
  expect(text(banner)).not.toContain("The panel moved to");
  expect(/<a [^>]*href="http:\/\/203\.0\.113\.20:3000"[^>]*>Open it/.test(banner)).toBe(true);
  // A banner that still hears from its panel says nothing of the sort.
  expect(text(await renderStatic(() => <PanelMoveBannerView status={shipping} />))).toContain(
    "The panel is moving to de-fsn-2: read-only for a few minutes.",
  );
});

test("a failed move shows until Try again, and the next move's failure shows again", () => {
  const first = { state: "failed" as const, moveId: "move000000000001" };
  expect(showsFailure(first, undefined)).toBe(true);
  expect(showsFailure(first, "move000000000001")).toBe(false);
  // Try again, Start, and that move fails too: its failure shows.
  expect(showsFailure({ state: "failed", moveId: "move000000000002" }, "move000000000001")).toBe(true);
  expect(showsFailure({ state: "idle", moveId: null }, undefined)).toBe(false);
});

test("waiting for the target to confirm the switch: how long, read-only, and Cancel anyway only after 10 minutes", async () => {
  const since = new Date(Date.now() - 125_000).toISOString();
  const waiting = moving({ step: "switching", canCancel: false, waitingSince: since });
  const out = text(await renderStatic(() => <MoveProgress status={waiting} />));
  expect(out).toContain("Waiting for de-fsn-2 to confirm the switch");
  expect(out).toMatch(/de-fsn-2 has not answered for 2m [45]s\. The panel stays read-only/);
  expect(out).not.toContain("Cancel anyway");
  expect(out).not.toContain("Cancel the move");
  const late = text(await renderStatic(() => <MoveProgress status={{ ...waiting, canForceCancel: true }} />));
  expect(late).toContain("If de-fsn-2 is gone for good, you can cancel the move anyway.");
  expect(late).toContain("Cancel anyway");
  // The banner stays: read-only until the target answers.
  const banner = text(await renderStatic(() => <PanelMoveBannerView status={waiting} />));
  expect(banner).toContain("The panel is moving to de-fsn-2 and waits for it to confirm the switch: read-only until then.");
  // Not while the switch goes ahead.
  expect(text(await renderStatic(() => <MoveProgress status={moving({ step: "switching", canCancel: false })} />))).not.toContain(
    "Waiting for",
  );
});

test("the node picker names every reason, plain http:// too, and a reason it does not know", () => {
  const node = check().targets[0] as MoveCheck["targets"][number];
  expect(targetLabel(node)).toBe("de-fsn-2");
  const plain = {
    ...node,
    ready: false,
    blocks: [{ code: "targetPlainHttp" as const, message: "de-fsn-2 connects over plain http://.", soft: false }],
  };
  expect(targetLabel(plain)).toBe("de-fsn-2 (connects over plain http://)");
  const unknown = {
    ...node,
    ready: false,
    blocks: [{ code: "targetSomethingNew", message: "No.", soft: false }],
  } as unknown as typeof node;
  expect(targetLabel(unknown)).toBe("de-fsn-2 (can't take the panel)");
});

test("the panel-wide refusals new in 0.2.8 show in the panel's words, unknown codes too", async () => {
  const blocked = check({
    blocks: [
      { code: "panelNodePlainHttp", message: "de-fsn-1 connects to the panel over plain http:// from another server.", soft: false },
      { code: "oldCopyLeft", message: "The last move's old copy is still on de-fsn-0. Delete the old copy first.", soft: false },
      { code: "somethingNewer", message: "A reason from a newer panel.", soft: false } as unknown as MoveCheck["blocks"][number],
    ],
  });
  const html = await renderStatic(() => <MoveFormView check={blocked} target={ids.fresh} onTarget={() => {}} />);
  const out = text(html);
  expect(out).toContain("de-fsn-1 connects to the panel over plain http:// from another server.");
  expect(out).toContain("Delete the old copy first.");
  expect(out).toContain("A reason from a newer panel.");
  expect(startButton(html)).toContain("disabled");
});

test("an address the panel refused shows its words under the field and keeps Start off", async () => {
  const refused = { address: "127.0.0.1", message: "Enter an address other servers can reach, not loopback." };
  const html = await renderStatic(() => (
    <MoveFormView check={check({ defaultAddress: "127.0.0.1" })} target={ids.fresh} onTarget={() => {}} refused={refused} />
  ));
  expect(text(html)).toContain("Enter an address other servers can reach, not loopback.");
  expect(startButton(html)).toContain("disabled");
});

test("the banner: on every page while it moves, on the old copy with a link, never otherwise", async () => {
  const run = text(await renderStatic(() => <PanelMoveBannerView status={moving({ step: "snapshot" })} />));
  expect(run).toContain("The panel is moving to de-fsn-2: read-only for a few minutes.");
  const old = await renderStatic(() => <PanelMoveBannerView status={moving({ state: "done", side: "old" })} />);
  expect(text(old)).toContain("The panel moved to de-fsn-2.");
  expect(hrefs(old)).toEqual(["http://203.0.113.20:3000"]);
  expect(await renderStatic(() => <PanelMoveBannerView status={status()} />)).not.toContain("panel-move-banner");
  expect(await renderStatic(() => <PanelMoveBannerView status={moving({ state: "done", side: "new" })} />)).not.toContain(
    "panel-move-banner",
  );
  expect(await renderStatic(() => <PanelMoveBannerView status={status({ state: "failed" })} />)).not.toContain("panel-move-banner");
});

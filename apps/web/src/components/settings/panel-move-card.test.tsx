import { expect, test } from "bun:test";
import { renderStatic } from "../../test/render";
import { PanelMoveBannerView } from "../shell/panel-move-banner";
import {
  type MoveCheck,
  MovedAway,
  MoveFailed,
  MoveFormView,
  MoveProgress,
  MoveResult,
  type MoveStatus,
  moveProgress,
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

test("the old copy says where the panel is now", async () => {
  const old = moving({ state: "done", side: "old", step: "switching", canCancel: false });
  const html = await renderStatic(() => <MovedAway status={old} />);
  expect(text(html)).toContain("The panel moved to de-fsn-2");
  expect(text(html)).toContain("This is the old copy.");
  expect(html).toContain('href="http://203.0.113.20:3000"');
  const withDomain = await renderStatic(() => <MovedAway status={{ ...old, domain: "panel.acme.dev" }} />);
  expect(withDomain).toContain('href="https://panel.acme.dev"');
});

test("the banner: on every page while it moves, on the old copy with a link, never otherwise", async () => {
  const run = text(await renderStatic(() => <PanelMoveBannerView status={moving({ step: "snapshot" })} />));
  expect(run).toContain("The panel is moving to de-fsn-2: read-only for a few minutes.");
  const old = await renderStatic(() => <PanelMoveBannerView status={moving({ state: "done", side: "old" })} />);
  expect(text(old)).toContain("The panel moved to de-fsn-2.");
  expect(old).toContain('href="http://203.0.113.20:3000"');
  expect(await renderStatic(() => <PanelMoveBannerView status={status()} />)).not.toContain("panel-move-banner");
  expect(await renderStatic(() => <PanelMoveBannerView status={moving({ state: "done", side: "new" })} />)).not.toContain(
    "panel-move-banner",
  );
  expect(await renderStatic(() => <PanelMoveBannerView status={status({ state: "failed" })} />)).not.toContain("panel-move-banner");
});

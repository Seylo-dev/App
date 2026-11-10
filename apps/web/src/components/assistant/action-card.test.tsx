import { describe, expect, test } from "bun:test";
import { approvals } from "@seylo/ops";
import { renderStatic } from "../../test/render";
import { type ToolCall, ToolCallCard } from "./action-card";

const target = { type: "service" as const, id: "svc0000000000002", name: "api", projectId: "prj0000000000001", projectName: "acme-shop" };
const restart: ToolCall = {
  type: "tool_call",
  toolCallId: "tu_1",
  opId: "services.restart",
  input: { serviceId: target.id },
  status: "done",
  approvalId: null,
  resultPreview: "{}",
  target,
};

const approval = {
  id: "appr000000000002",
  opId: "services.restart",
  opSummary: "Restart a service",
  opKind: "mutation",
  inputPreview: { serviceId: target.id },
  via: "ai",
  source: { kind: "assistant", conversationId: "conv000000000001", title: "Api is slow", mine: true },
  requestedBy: { userId: "user000000000001", userName: "Owner", clientName: "AI assistant" },
  reason: "The api answers 502.",
  target: { type: "service", id: target.id, name: "api" },
  status: "pending",
  decidedBy: null,
  decidedAt: null,
  error: null,
  expiresAt: "2026-11-11T10:00:00.000Z",
  createdAt: "2026-11-10T10:00:00.000Z",
};

// Every tool call shows as a card saying what happened, on what, with the
// outcome and a link; one that needs an approval asks in place with Approve
// and Reject (owner request).
describe("action cards", () => {
  test("a finished change: the sentence, the project, the outcome, Auto when it ran without asking, and a link", async () => {
    const out = await renderStatic(() => <ToolCallCard part={{ ...restart, auto: true }} />);
    expect(out).toContain("Restarted api");
    expect(out).toContain("in acme-shop");
    expect(out).toContain(">Done<");
    expect(out).toContain(">Auto<");
    expect(out).toContain(`href="/p/${target.projectId}/s/${target.id}"`);
    // Details stay closed until asked for.
    expect(out).not.toContain("serviceId");
  });

  test("a failed call says so with the panel's message", async () => {
    const out = await renderStatic(() => (
      <ToolCallCard part={{ ...restart, status: "error", resultPreview: "FORBIDDEN: You may not restart this service." }} />
    ));
    expect(out).toContain("Could not restart api");
    expect(out).toContain(">Failed<");
    expect(out).toContain("FORBIDDEN: You may not restart this service.");
  });

  test("a call that waits for an approval asks, with Approve and Reject, from the same approval as the Approvals page", async () => {
    const part = { ...restart, status: "needs_approval" as const, approvalId: approval.id, resultPreview: null };
    const out = await renderStatic(() => <ToolCallCard part={part} />, [[approvals.get, { approvalId: approval.id }, approval]]);
    expect(out).toContain("Restart api?");
    expect(out).toContain("for Owner");
    // The buttons say it waits; the status chip comes once it is decided.
    expect(out).not.toContain(">Waiting<");
    expect(out).toContain(">Approve<");
    expect(out).toContain(">Reject<");

    const decided = await renderStatic(
      () => <ToolCallCard part={{ ...part, status: "done" }} />,
      [
        [
          approvals.get,
          { approvalId: approval.id },
          { ...approval, status: "executed", decidedBy: { id: "user000000000001", name: "Owner" }, decidedAt: approval.createdAt },
        ],
      ],
    );
    expect(decided).toContain("Done by Owner");
    expect(decided).not.toContain(">Approve<");
  });
});

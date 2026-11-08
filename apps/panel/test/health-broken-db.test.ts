import { expect, test } from "bun:test";
import { testPanel } from "./helpers";

// The container health check and the panel update's health gate read
// /api/health. A panel that cannot read its database must answer 503 there,
// or a broken panel counts as healthy and an update never rolls back. The
// request hook that sets the security headers reads a setting first; it
// must not turn a broken database into a 200.
test("/api/health answers 503 when the database cannot be read", async () => {
  const panel = testPanel();
  const ok = await panel.app.handle(new Request("http://panel.test/api/health"));
  expect(ok.status).toBe(200);
  panel.close();
  const broken = await panel.app.handle(new Request("http://panel.test/api/health"));
  expect(broken.status).toBe(503);
  expect(((await broken.json()) as { status: string }).status).toBe("unavailable");
});

test("other routes never answer 200 when the database cannot be read", async () => {
  const panel = testPanel();
  panel.close();
  const res = await panel.app.handle(new Request("http://panel.test/api/v1/auth.whoami"));
  // The session lookup fails closed (401); before, the request hook's error came back as a 200.
  expect(res.status).toBeGreaterThanOrEqual(400);
});

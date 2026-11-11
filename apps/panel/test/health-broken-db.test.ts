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

// The panel domain check proves a domain reaches this panel: with ?proof=<nonce>
// /api/health answers what only this panel's key gives (http/health-proof.ts).
test("/api/health?proof answers this panel's proof of the nonce, and nothing for a bad one", async () => {
  const panel = testPanel();
  const other = testPanel();
  try {
    const nonce = "abcDEF0123456789_-xyz";
    const ask = async (p: typeof panel, query: string) =>
      (await (await p.app.handle(new Request(`http://panel.test/api/health${query}`))).json()) as { status: string; proof?: string };
    const answer = await ask(panel, `?proof=${nonce}`);
    expect(answer.status).toBe("ok");
    expect(panel.deps.healthProof.proves(nonce, answer.proof)).toBe(true);
    // Another panel's answer for the same nonce proves nothing here.
    expect(panel.deps.healthProof.proves(nonce, (await ask(other, `?proof=${nonce}`)).proof)).toBe(false);
    expect(panel.deps.healthProof.proves("abcDEF0123456789_-xyZ", answer.proof)).toBe(false);
    for (const query of ["", "?proof=", "?proof=short", `?proof=${"a".repeat(200)}`, "?proof=has%20space%20in%20it%20ok"]) {
      expect((await ask(panel, query)).proof).toBeUndefined();
    }
  } finally {
    panel.close();
    other.close();
  }
});

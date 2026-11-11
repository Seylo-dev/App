// What the old panel sees at the moved panel's address while the target
// leaves CommitMovedPanel unanswered (orchestrator.ts): HTTPS GET
// https://<address>:<agents' port>/api/health, trusted only when the
// answer comes over a connection that presents the agents' TLS key, the
// one every node pins. The moved panel answers "moveId" while it waits as
// the copy of that move, with "switched": true once the commit marker of
// that move is in its data folder, and no "moveId" once its first agent
// committed the arrival. The old panel never answers at that address: the
// preflight refuses the old server's addresses, and every node's probe at
// staging saw the move id there.
//
// A commit whose answer was lost while the target was away for 10 s may
// have moved the target onto the moved panel for good; this is how the old
// panel finds out instead of offering a forced cancel that would leave two
// live panels.

import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { spkiPin } from "../../security/x509";

export type MovedPanelSeen =
  /** The moved panel took over: healthy, with the agents' key, waiting for no move. */
  | "arrived"
  /** The moved copy of this move has its commit marker: the switch landed on the target. */
  | "switched"
  /** The moved copy of this move answers and still waits for the switch. */
  | "standby"
  /** No answer that counts: no route, a closed port, another key, not healthy, another move. */
  | "noAnswer";

/** The commit landed on the target, whatever its answer did. */
export function tookTheSwitch(seen: MovedPanelSeen): boolean {
  return seen === "arrived" || seen === "switched";
}

const probeTimeoutMs = 10_000;
const maxBodyBytes = 64 * 1024;

/** Swapped by tests, which have no moved panel to reach. */
export const movedPanelProbe = { see: probeMovedPanel };

/** GET <base>/api/health over a connection that must present the key of `pin`. */
export function probeMovedPanel(base: string, pin: string, moveId: string, timeoutMs = probeTimeoutMs): Promise<MovedPanelSeen> {
  const url = new URL("/api/health", base);
  return new Promise((resolve) => {
    let req: ReturnType<typeof request> | undefined;
    let settled = false;
    const done = (seen: MovedPanelSeen) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(seen);
    };
    const timer = setTimeout(() => done("noAnswer"), timeoutMs);
    try {
      req = request(
        {
          host: url.hostname.replace(/^\[|\]$/g, ""),
          port: Number(url.port || 443),
          path: url.pathname,
          method: "GET",
          agent: false,
          // The certificate is self-signed: its key is checked against the pin before the answer counts.
          rejectUnauthorized: false,
          headers: { accept: "application/json" },
        },
        (res) => {
          if (peerPin(res.socket as TLSSocket) !== pin) return done("noAnswer");
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBodyBytes) return done("noAnswer");
            chunks.push(chunk);
          });
          res.on("end", () => done(classify(res.statusCode ?? 0, Buffer.concat(chunks), moveId)));
          res.on("error", () => done("noAnswer"));
        },
      );
      req.on("error", () => done("noAnswer"));
      req.end();
    } catch {
      done("noAnswer");
    }
  });
}

function peerPin(socket: TLSSocket): string | null {
  try {
    const raw = socket.getPeerCertificate(true)?.raw;
    return raw ? spkiPin(new X509Certificate(raw).publicKey) : null;
  } catch {
    return null;
  }
}

function classify(status: number, body: Buffer, moveId: string): MovedPanelSeen {
  if (status !== 200) return "noAnswer";
  let answer: unknown;
  try {
    answer = JSON.parse(body.toString("utf8"));
  } catch {
    return "noAnswer";
  }
  if (!answer || typeof answer !== "object") return "noAnswer";
  const fields = answer as { status?: unknown; moveId?: unknown; switched?: unknown };
  if (fields.status !== "ok") return "noAnswer";
  if (fields.moveId === undefined || fields.moveId === null) return "arrived";
  if (fields.moveId !== moveId) return "noAnswer";
  return fields.switched === true ? "switched" : "standby";
}

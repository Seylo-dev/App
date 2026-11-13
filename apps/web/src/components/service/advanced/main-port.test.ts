import { describe, expect, test } from "bun:test";
import { mainPortMove, mainPortNote } from "./main-port";

const tcp = (...ports: number[]) => ports.map((containerPort) => ({ containerPort, protocol: "tcp" as const }));
const live = { id: "d000000000000001", label: "7f02b1d", createdAt: "2026-11-13T10:00:00.000Z" };

describe("the main port line", () => {
  test("names the old and new main port when the old one is gone", () => {
    expect(mainPortMove(tcp(3000), tcp(6000))).toEqual({ from: 3000, to: 6000 });
    expect(mainPortMove(tcp(3000, 8080), tcp(6000, 8080))).toEqual({ from: 3000, to: 6000 });
    // UDP is not the main port; an unfinished row (0) is not either.
    expect(mainPortMove([{ containerPort: 53, protocol: "udp" }, ...tcp(3000)], tcp(0, 6000))).toEqual({ from: 3000, to: 6000 });
  });

  test("says nothing when the main port stays, the old one is still a port, or there is none", () => {
    expect(mainPortMove(tcp(3000), tcp(3000))).toBeNull();
    expect(mainPortMove(tcp(3000, 8080), tcp(8080, 3000))).toBeNull();
    expect(mainPortMove(tcp(3000), [])).toBeNull();
    expect(mainPortMove([], tcp(6000))).toBeNull();
  });

  test("with a live version they move with the next deploy, without one on save", () => {
    expect(mainPortNote({ ports: tcp(3000), liveDeployment: live }, tcp(6000))).toBe(
      "The domains, IP:port access and Cloudflare tunnel on port 3000 move to 6000 when the next deploy rolls out, with the new containers. A domain on another port stays.",
    );
    expect(mainPortNote({ ports: tcp(3000), liveDeployment: null }, tcp(6000))).toBe(
      "The domains, IP:port access and Cloudflare tunnel on port 3000 move to 6000 when you save. A domain on another port stays.",
    );
    expect(mainPortNote({ ports: tcp(3000), liveDeployment: live }, tcp(3000))).toBeNull();
  });
});

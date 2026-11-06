import { describe, expect, test } from "bun:test";
import goldenFrames from "../../../go/internal/conn/testdata/frames.json";
import { encodeFrame, FrameError, HEADER_SIZE, isControl, MAX_FRAME_SIZE, parseFrame, parseWindow, windowFrame } from "./frame";
import { FrameKind } from "./gen/seylo/agent/v1/envelope_pb";

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("frame codec matches the Go golden fixtures", () => {
  for (const golden of goldenFrames) {
    test(golden.name, () => {
      const encoded = encodeFrame({
        kind: golden.kind as FrameKind,
        stream: golden.stream,
        payload: fromHex(golden.payloadHex),
      });
      expect(toHex(encoded)).toBe(golden.encodedHex);

      const parsed = parseFrame(fromHex(golden.encodedHex));
      expect(parsed.kind as number).toBe(golden.kind);
      expect(parsed.stream).toBe(golden.stream);
      expect(toHex(parsed.payload)).toBe(golden.payloadHex);
    });
  }
});

describe("parseFrame", () => {
  test("rejects short frames", () => {
    expect(() => parseFrame(new Uint8Array(HEADER_SIZE - 1))).toThrow(FrameError);
  });

  test("rejects unknown kinds", () => {
    expect(() => parseFrame(Uint8Array.of(0, 0, 0, 0, 1))).toThrow(FrameError);
    expect(() => parseFrame(Uint8Array.of(8, 0, 0, 0, 1))).toThrow(FrameError);
  });

  test("rejects oversized frames", () => {
    expect(() => parseFrame(new Uint8Array(MAX_FRAME_SIZE + 1))).toThrow(FrameError);
  });

  test("reads frames at a non-zero buffer offset", () => {
    const backing = Uint8Array.of(0xff, 0xff, ...encodeFrame({ kind: FrameKind.DATA, stream: 9, payload: Uint8Array.of(7) }));
    const frame = parseFrame(backing.subarray(2));
    expect(frame.stream).toBe(9);
    expect(Array.from(frame.payload)).toEqual([7]);
  });
});

describe("window frames", () => {
  test("round trip", () => {
    expect(parseWindow(windowFrame(3, 65536).payload)).toBe(65536);
  });

  test("reject zero and bad sizes", () => {
    expect(() => parseWindow(new Uint8Array(4))).toThrow(FrameError);
    expect(() => parseWindow(new Uint8Array(3))).toThrow(FrameError);
  });
});

test("only DATA is flow controlled", () => {
  expect(isControl(FrameKind.DATA)).toBe(false);
  expect(isControl(FrameKind.CALL)).toBe(true);
  expect(isControl(FrameKind.WINDOW)).toBe(true);
});

// The Go side writes go/internal/rpc/testdata/envelopes.json (TestGoldenEnvelopes);
// this checks the TypeScript encoding agrees byte for byte.
import { describe, expect, test } from "bun:test";
import { create, type DescMessage, fromBinary, toBinary } from "@bufbuild/protobuf";
import { sizeDelimitedEncode, sizeDelimitedPeek } from "@bufbuild/protobuf/wire";
import { slug } from "../../../brand/brand.json";
import golden from "../../../go/internal/rpc/testdata/envelopes.json";
import { CallSchema, CloseSchema, OpenSchema, ResultSchema } from "./gen/seylo/agent/v1/envelope_pb";
import { LogsFollowResponseSchema } from "./gen/seylo/agent/v1/logs_pb";

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const schemas: Record<string, DescMessage> = { call: CallSchema, result: ResultSchema, open: OpenSchema, close: CloseSchema };

describe("envelopes match the Go golden fixtures", () => {
  for (const g of golden) {
    test(g.name, () => {
      const bytes = fromHex(g.hex);
      if (g.kind === "hello") {
        // "<slug>-agent-hello-v1" 0 panel_id 0 node_id 0 nonce, as in handshake.proto.
        const text = new TextDecoder().decode(bytes.subarray(0, bytes.length - 32));
        const [context, panelId, nodeId] = text.split("\0");
        expect(context).toBe(`${slug}-agent-hello-v1`);
        const rebuilt = new TextEncoder().encode(`${context}\0${panelId}\0${nodeId}\0`);
        expect(toHex(new Uint8Array([...rebuilt, ...bytes.subarray(bytes.length - 32)]))).toBe(g.hex);
        return;
      }
      if (g.kind === "delimited") {
        const lines: string[] = [];
        let out = new Uint8Array();
        for (let rest = bytes; rest.length > 0; ) {
          const peek = sizeDelimitedPeek(rest);
          if (peek.eof || peek.offset === undefined) throw new Error("truncated");
          const msg = fromBinary(LogsFollowResponseSchema, rest.subarray(peek.offset, peek.offset + peek.size));
          lines.push(msg.entries[0]?.line ?? "");
          out = new Uint8Array([...out, ...sizeDelimitedEncode(LogsFollowResponseSchema, create(LogsFollowResponseSchema, msg))]);
          rest = rest.subarray(peek.offset + peek.size);
        }
        expect(lines).toEqual(["first", "second line"]);
        expect(toHex(out)).toBe(g.hex);
        return;
      }
      const schema = schemas[g.kind];
      if (!schema) throw new Error(`unknown kind ${g.kind}`);
      expect(toHex(toBinary(schema, fromBinary(schema, bytes)))).toBe(g.hex);
    });
  }
});

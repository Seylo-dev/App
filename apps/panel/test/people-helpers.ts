// Helpers for the people tests: signing in over HTTP, seeding
// projects and services, a mock GitHub for the device flow and a virtual
// WebAuthn authenticator that produces real ES256 signatures.

import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { type AnyOpContract, type OpInput, secureSessionCookie, sessionCookie, sessionKeyHeader } from "@seylo/ops";
import { overrideGithubEndpoints } from "../src/auth/github-device";
import { projects, services } from "../src/db/schema";
import type { RateLimiter } from "../src/ops/rate-limit";
import type { Panel } from "../src/panel";
import { type CallOptions, callOp, sessionCookieFor } from "./helpers";

/** A limiter that never limits, for tests that sign in many times. */
export const noLimits: RateLimiter = { take: () => 0 };

/**
 * The session cookie a response set, as a Cookie header value; undefined
 * when none. Remembers the session key the response handed out, so callOp
 * sends it along like the web app.
 */
export function cookieFrom(headers: Headers): string | undefined {
  for (const line of headers.getSetCookie()) {
    const pair = line.split(";")[0] as string;
    for (const name of [sessionCookie, secureSessionCookie]) {
      if (pair.startsWith(`${name}=`) && pair.length > name.length + 1) {
        return sessionCookieFor(pair.slice(name.length + 1), headers.get(sessionKeyHeader) ?? "", name === secureSessionCookie);
      }
    }
  }
  return undefined;
}

/** An op's input with fields that have defaults (or are optional) left out allowed. */
export type LooseInput<C extends AnyOpContract> = { [K in keyof OpInput<C>]?: OpInput<C>[K] };

/** callOp that lets defaulted fields be left out, as real clients do. */
export function call<C extends AnyOpContract>(panel: Panel, op: C, input: LooseInput<C>, options: CallOptions = {}) {
  return callOp(panel, op, input as OpInput<C>, options);
}

/** Calls an op and fails the test with the error body when it does not answer 200. */
export async function ok<C extends AnyOpContract>(panel: Panel, op: C, input: LooseInput<C>, options: CallOptions = {}) {
  const result = await call(panel, op, input, options);
  if (result.status !== 200) throw new Error(`${op.id} answered ${result.status}: ${JSON.stringify(result.body)}`);
  return result;
}

export function seedProject(panel: Panel, name = `p${crypto.randomUUID().slice(0, 6)}`) {
  return panel.deps.db.insert(projects).values({ name, nameKey: name.toLowerCase() }).returning().get();
}

export function seedService(panel: Panel, projectId: string, name = `s${crypto.randomUUID().slice(0, 6)}`) {
  return panel.deps.db.insert(services).values({ projectId, name, nameKey: name.toLowerCase(), kind: "app", spec: {} }).returning().get();
}

// ---------------------------------------------------------------------------
// Mock GitHub

export interface MockGithub {
  /** What the next access_token polls answer, in order; the last one repeats. */
  pollAnswers: Record<string, unknown>[];
  user: { id: number; login: string; name: string | null };
  emails: { email: string; primary: boolean; verified: boolean }[];
  requests: { url: string; body: string }[];
}

export function mockGithub(panel: Panel, init: Partial<MockGithub> = {}): MockGithub {
  const state: MockGithub = {
    pollAnswers: [{ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" }],
    user: { id: 4242, login: "octo", name: "Octo Cat" },
    emails: [{ email: "Octo@Example.com", primary: true, verified: true }],
    requests: [],
    ...init,
  };
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    state.requests.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/login/device/code")) {
      return Response.json({
        device_code: "device-code-secret",
        user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      });
    }
    if (url.endsWith("/login/oauth/access_token")) {
      const answer = state.pollAnswers.length > 1 ? state.pollAnswers.shift() : state.pollAnswers[0];
      return Response.json(answer);
    }
    if (url.endsWith("/user")) return Response.json(state.user);
    if (url.endsWith("/user/emails")) return Response.json(state.emails);
    return new Response("not found", { status: 404 });
  };
  overrideGithubEndpoints(panel.deps.db, {
    clientId: "Iv1.testclient",
    loginBase: "https://github.test",
    apiBase: "https://api.github.test",
    fetch: fake as typeof fetch,
  });
  return state;
}

/** The panel accepts one poll per interval (1 s in the mock). */
export const waitForPoll = () => Bun.sleep(800);

// ---------------------------------------------------------------------------
// Virtual WebAuthn authenticator (ES256, "none" attestation)

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

/** Minimal CBOR encoder: unsigned and negative ints, byte and text strings, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    if (length < 65536) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(length, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}

export class VirtualAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private readonly privateKey: KeyObject;
  private readonly cose: Buffer;
  private counter = 0;
  private userHandle = "";

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })).export({ format: "jwk" });
    this.cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
  }

  private authData(flags: number, attested: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha256(this.rpId), Buffer.from([flags]), count];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), idLength, Buffer.from(this.credentialId), this.cose);
    }
    return Buffer.concat(parts);
  }

  /** navigator.credentials.create() for the options from passkeyRegisterBegin. */
  register(options: Record<string, unknown>) {
    this.userHandle = String((options.user as { id: string }).id);
    const clientData = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    // UP | UV | AT
    const attestation = cbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(0x45, true)],
      ]),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestation), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() for the options from passkeyLoginBegin. */
  assert(options: Record<string, unknown>, overrides: { origin?: string } = {}) {
    this.counter += 1;
    const clientData = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: overrides.origin ?? this.origin, crossOrigin: false }),
    );
    const authData = this.authData(0x05, false);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

import { expect, test } from "bun:test";
import { OpError, projects } from "../src";
import { createOpClient } from "../src/client/client";

function fakeFetch(respond: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test("queries send input as query params", async () => {
  const { fetch, calls } = fakeFetch(() => Response.json({ id: "x" }));
  const client = createOpClient({ baseUrl: "http://panel.test", fetch });
  await client.call(projects.get, { projectId: "abcdefghijklmnop" });
  expect(calls[0]?.init.method).toBe("GET");
  expect(calls[0]?.url.toString()).toBe("http://panel.test/api/v1/projects.get?projectId=abcdefghijklmnop");
});

test("mutations send a JSON body", async () => {
  const { fetch, calls } = fakeFetch(() => Response.json({}));
  const client = createOpClient({ baseUrl: "http://panel.test", fetch });
  await client.call(projects.create, { name: "shop" });
  expect(calls[0]?.init.method).toBe("POST");
  expect(calls[0]?.init.body).toBe('{"name":"shop"}');
});

test("error bodies become OpError with the server's code", async () => {
  const { fetch } = fakeFetch(() => Response.json({ error: { code: "CONFLICT", message: "taken" } }, { status: 409 }));
  const client = createOpClient({ baseUrl: "http://panel.test", fetch });
  const error = await client.call(projects.create, { name: "shop" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpError);
  expect((error as OpError).code).toBe("CONFLICT");
  expect((error as OpError).message).toBe("taken");
});

test("network failures become UNAVAILABLE", async () => {
  const fetch = (async () => {
    throw new TypeError("connection refused");
  }) as unknown as typeof globalThis.fetch;
  const error = await createOpClient({ baseUrl: "http://panel.test", fetch })
    .call(projects.list, {})
    .catch((e: unknown) => e);
  expect((error as OpError).code).toBe("UNAVAILABLE");
});

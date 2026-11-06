// Records the Docker Hub answers the dockerHub tests replay (no network in
// tests). Run by hand when Docker Hub changes shape:
//
//   bun apps/panel/test/fixtures/dockerhub/record.ts
//   bunx biome format --write apps/panel/test/fixtures/dockerhub
//
// Registry files (*.raw) are kept byte for byte, since the client checks
// every manifest and config against its digest (Biome leaves .raw alone).
// Tokens are never written, and the Hub answers lose the account names of
// whoever pushed a tag.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const repo = "gitea/gitea";
const tag = "28.3.0";
const accept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Drops who pushed a tag: account names are not needed by any test. */
function anonymize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(anonymize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "creator" || key === "last_updater" || key === "last_updater_username") continue;
    out[key] = anonymize(child);
  }
  return out;
}

async function json(url: string, name: string): Promise<void> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(join(dir, name), `${JSON.stringify(anonymize(await res.json()), null, 2)}\n`);
}

async function raw(url: string, token: string, name: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { accept, authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(join(dir, name), bytes);
  return bytes;
}

mkdirSync(join(dir, "registry"), { recursive: true });
await json("https://hub.docker.com/api/search/v4?query=gitea&from=0&size=10", "search-v4-gitea.json");
await json("https://hub.docker.com/v2/search/repositories/?query=nginx&page=1&page_size=6", "search-v2-nginx.json");
await json(
  "https://hub.docker.com/v2/namespaces/gitea/repositories/gitea/tags?page=1&page_size=15&ordering=last_updated",
  "tags-gitea.json",
);
await json("https://hub.docker.com/v2/namespaces/gitea/repositories/gitea/tags/latest", "tag-latest-gitea.json");

const auth = (await (await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`)).json()) as {
  token: string;
};
const head = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, {
  method: "HEAD",
  headers: { accept, authorization: `Bearer ${auth.token}` },
});
const indexDigest = head.headers.get("docker-content-digest") ?? "";
const index = JSON.parse(
  new TextDecoder().decode(await raw(`https://registry-1.docker.io/v2/${repo}/manifests/${indexDigest}`, auth.token, "registry/index.raw")),
) as { manifests: { digest: string; platform?: { os?: string; architecture?: string } }[] };
const meta: Record<string, unknown> = { repository: repo, tag, indexDigest, indexContentType: head.headers.get("content-type") };
for (const arch of ["amd64", "arm64"]) {
  const entry = index.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === arch);
  if (!entry) throw new Error(`no linux/${arch} in the index`);
  const manifest = JSON.parse(
    new TextDecoder().decode(
      await raw(`https://registry-1.docker.io/v2/${repo}/manifests/${entry.digest}`, auth.token, `registry/manifest-${arch}.raw`),
    ),
  ) as { config: { digest: string } };
  await raw(`https://registry-1.docker.io/v2/${repo}/blobs/${manifest.config.digest}`, auth.token, `registry/config-${arch}.raw`);
  meta[arch] = { manifestDigest: entry.digest, configDigest: manifest.config.digest };
}
writeFileSync(join(dir, "registry/meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
console.log("recorded", meta);

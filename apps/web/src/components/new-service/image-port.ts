// Which Docker Hub image a typed image reference names, so the New app
// dialog can read its exposed port (dockerHub.inspect) and fill the Port
// field with it. Only Docker Hub: another registry, a digest or a name the
// Docker Hub ops refuse gives null, and the field keeps its default.

import { dockerHub } from "@seylo/ops";

const repositoryPattern = new RegExp(dockerHub.Repository.pattern as string);
const tagPattern = new RegExp(dockerHub.Tag.pattern as string);

/** "nginx:1.27" -> { repository: "nginx", tag: "1.27" }; "ghcr.io/acme/api:1" -> null. */
export function dockerHubRef(image: string): { repository: string; tag: string } | null {
  const text = image.trim();
  if (text === "" || /\s/.test(text) || text.includes("@")) return null;
  const rest = text.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//i, "");
  const first = rest.split("/")[0] ?? "";
  if (rest.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) return null;
  const slash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  const name = colon > slash ? rest.slice(0, colon) : rest;
  const tag = colon > slash ? rest.slice(colon + 1) : "latest";
  const repository = name.startsWith("library/") ? name.slice("library/".length) : name;
  if (!repositoryPattern.test(repository) || !tagPattern.test(tag)) return null;
  return { repository, tag };
}

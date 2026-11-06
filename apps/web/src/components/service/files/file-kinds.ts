// What the Files popup does with a file, from its name: the Monaco language
// for text files, and whether it is an archive files.extract can unpack.

const languages: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "javascript",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  yaml: "yaml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  xml: "xml",
  svg: "xml",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  toml: "ini",
  properties: "ini",
};

export function languageFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) return "seylo-env";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return languages[ext] ?? "plaintext";
}

export function isArchive(name: string): boolean {
  return /\.(tar\.gz|tgz|zip)$/i.test(name);
}

/** "a/b/c" -> ["a", "a/b", "a/b/c"] for breadcrumbs. */
export function pathCrumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter((p) => p && p !== ".");
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}

export function joinPath(dir: string, name: string): string {
  const clean = dir.replace(/^\.?\/*|\/+$/g, "");
  return clean ? `${clean}/${name}` : name;
}

export function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/** Parses "0644" or "644" into mode bits; null when it is not octal. */
export function parseOctal(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-7]{3,4}$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 8);
}

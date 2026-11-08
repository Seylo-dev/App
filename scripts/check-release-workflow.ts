// Release isolation check (make test-release). A build dependency runs with
// whatever its job holds, so:
//
//   - no GitHub Actions job that holds a write token or a secret runs bun,
//     npm, node or another JavaScript tool: not in a run step, not through a
//     make target or a script that step calls, and it sets up no JavaScript
//     runtime;
//   - goreleaser's hooks run none either (goreleaser runs in such a job).
//
// A job holds a write token when its permissions (or the workflow's, when it
// sets none) grant a write, or when neither sets any (the repository default
// may be write). It holds a secret when it uses an environment or names
// secrets.* or github.token. The Release workflow builds the web app and the
// panel in its read-only Build and test job and hands the files on
// (.github/workflows/release.yml); this check keeps it that way.
//
// Usage: bun scripts/check-release-workflow.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; uses?: string; run?: string };
type Job = { name?: string; permissions?: unknown; environment?: unknown; steps?: Step[] };
type Workflow = { permissions?: unknown; jobs?: Record<string, Job> };

export interface Sources {
  /** Workflow file name -> its YAML. */
  workflows: Record<string, string>;
  goreleaser: string;
  makefile: string;
  /** A repository file by its path from the root, undefined when missing. */
  readFile: (path: string) => string | undefined;
}

const jsTools = ["bun", "bunx", "npm", "npx", "pnpm", "yarn", "node", "deno", "corepack", "tsx", "vite"];
// A JavaScript tool where a shell runs a command: at the start of a line or
// after an operator or keyword, maybe behind VAR=value assignments or a path.
const jsCommand = new RegExp(
  String.raw`(?:^|[;&|({\x60]|\$\(|\b(?:then|do|else|elif|if|while|until|exec|xargs|sudo|env|time|command|nohup)\s)` +
    String.raw`\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*/)?(${jsTools.join("|")})(?=[\s;&|)]|$)`,
  "m",
);
const makeCall = /(?:^|[;&|(]|\$\(|\b(?:then|do|else)\s)\s*(?:make|\$\(MAKE\))((?:\s+[A-Za-z0-9_.=$()/-]+)+)/gm;
const scriptCall = /(?:^|[\s;&|(=])(?:\.\/)?((?:scripts|installer|deploy|tools|test)\/[A-Za-z0-9_./-]+\.(?:sh|bash))\b/gm;
const jsActions = /^(oven-sh\/setup-bun|actions\/setup-node|pnpm\/action-setup|denoland\/setup-deno)@/;

/** Shell text without comments (a # that starts a word, to the end of the line). */
function stripComments(text: string): string {
  return text.replace(/(^|\s)#.*$/gm, "$1");
}

interface Makefile {
  vars: Map<string, string>;
  targets: Map<string, { prereqs: string[]; recipe: string }>;
}

function parseMakefile(text: string): Makefile {
  const lines = text.replace(/\\\n/g, " ").split("\n");
  const vars = new Map<string, string>();
  const targets = new Map<string, { prereqs: string[]; recipe: string }>();
  let current: { prereqs: string[]; recipe: string } | undefined;
  for (const line of lines) {
    if (line.startsWith("\t")) {
      if (current) current.recipe += `${line.slice(1)}\n`;
      continue;
    }
    current = undefined;
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:?+]?=\s*(.*)$/.exec(line);
    if (assign) {
      vars.set(assign[1] as string, assign[2] as string);
      continue;
    }
    const rule = /^([A-Za-z0-9_-][A-Za-z0-9_. -]*):(?!=)([^#]*)/.exec(line);
    if (!rule) continue;
    const prereqs = (rule[2] as string).trim().split(/\s+/).filter(Boolean);
    current = { prereqs, recipe: "" };
    for (const name of (rule[1] as string).trim().split(/\s+/)) targets.set(name, current);
  }
  return { vars, targets };
}

/** Makefile text with $(VAR) references replaced by their values. */
function expandVars(text: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 10) return text;
  const out = text.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (whole, name: string) => (name === "MAKE" ? whole : (vars.get(name) ?? "")));
  return out === text ? out : expandVars(out, vars, depth + 1);
}

class Checker {
  private readonly make: Makefile;
  private readonly seen = new Set<string>();

  constructor(private readonly sources: Sources) {
    this.make = parseMakefile(sources.makefile);
  }

  /** Why this shell text (and what it calls) runs a JavaScript tool, or undefined. */
  shell(text: string, where: string): string | undefined {
    const code = stripComments(text);
    const js = jsCommand.exec(code);
    if (js) return `${where} runs ${js[1]}`;
    if (/node_modules/.test(code)) return `${where} runs something from node_modules`;
    for (const m of code.matchAll(makeCall)) {
      for (const word of (m[1] as string).trim().split(/\s+/)) {
        if (word.startsWith("-") || word.includes("=") || word.includes("$")) continue;
        const why = this.target(word);
        if (why) return `${where} runs make ${word}: ${why}`;
      }
    }
    for (const m of code.matchAll(scriptCall)) {
      const path = m[1] as string;
      const why = this.script(path);
      if (why) return `${where} runs ${path}: ${why}`;
    }
    return undefined;
  }

  private target(name: string): string | undefined {
    const key = `make:${name}`;
    if (this.seen.has(key)) return undefined;
    this.seen.add(key);
    const target = this.make.targets.get(name);
    if (!target) return undefined;
    for (const prereq of target.prereqs) {
      const why = this.target(prereq);
      if (why) return `its prerequisite ${prereq}: ${why}`;
    }
    return this.shell(expandVars(target.recipe, this.make.vars), "its recipe");
  }

  private script(path: string): string | undefined {
    const key = `script:${path}`;
    if (this.seen.has(key)) return undefined;
    this.seen.add(key);
    const text = this.sources.readFile(path);
    return text === undefined ? undefined : this.shell(text, "it");
  }

  /** Every way the goreleaser config runs a JavaScript tool. */
  goreleaser(): string[] {
    const config = Bun.YAML.parse(this.sources.goreleaser) as Record<string, unknown>;
    const commands: string[] = [];
    const collect = (value: unknown, inHooks: boolean): void => {
      if (typeof value === "string") {
        if (inHooks) commands.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) collect(item, inHooks);
      } else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) collect(item, inHooks || key === "hooks" || key === "cmd");
      }
    };
    collect(config, false);
    return commands.flatMap((command) => {
      this.seen.clear();
      const why = this.shell(command, `the goreleaser hook "${command}"`);
      return why ? [why] : [];
    });
  }

  /** Every privileged job step that runs a JavaScript tool, per workflow. */
  workflows(): string[] {
    const problems: string[] = [];
    for (const [file, text] of Object.entries(this.sources.workflows)) {
      const workflow = Bun.YAML.parse(text) as Workflow;
      for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
        const holds = privileged(workflow, job);
        if (!holds) continue;
        const label = `${file} job ${id} (${holds})`;
        for (const [index, step] of (job.steps ?? []).entries()) {
          const stepName = step.name ?? step.uses ?? step.run?.split("\n")[0] ?? `step ${index + 1}`;
          if (step.uses && jsActions.test(step.uses)) {
            problems.push(`${label}: step "${stepName}" sets up a JavaScript runtime (${step.uses.split("@")[0]})`);
          }
          if (step.uses?.startsWith("./")) problems.push(`${label}: step "${stepName}" runs a local action this check cannot read`);
          if (step.run) {
            this.seen.clear();
            const why = this.shell(step.run, `step "${stepName}"`);
            if (why) problems.push(`${label}: ${why}`);
          }
        }
      }
    }
    return problems;
  }
}

/** What a job holds that a build dependency must not reach, or "" for nothing. */
function privileged(workflow: Workflow, job: Job): string {
  const permissions = job.permissions ?? workflow.permissions;
  if (permissions === undefined) return "the repository's default token permissions";
  if (permissions === "write-all") return "a write token";
  if (permissions && typeof permissions === "object" && Object.values(permissions).includes("write")) return "a write token";
  if (job.environment !== undefined) return "an environment's secrets";
  if (/\bsecrets\s*[.[]|\bgithub\.token\b/.test(JSON.stringify(job))) return "a secret";
  return "";
}

/** Every problem the check finds in these sources. */
export function check(sources: Sources): string[] {
  const checker = new Checker(sources);
  return [...checker.goreleaser(), ...checker.workflows()];
}

function repoSources(root: string): Sources {
  const dir = join(root, ".github/workflows");
  const workflows: Record<string, string> = {};
  for (const file of readdirSync(dir).sort()) {
    if (file.endsWith(".yml") || file.endsWith(".yaml")) workflows[file] = readFileSync(join(dir, file), "utf8");
  }
  return {
    workflows,
    goreleaser: readFileSync(join(root, ".goreleaser.yaml"), "utf8"),
    makefile: readFileSync(join(root, "Makefile"), "utf8"),
    readFile: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined),
  };
}

// The check must catch what it is for: each case is one way a build
// dependency could reach a write token or a secret.
const goodGoreleaser = "before:\n  hooks:\n    - scripts/render-installer.sh {{ .Version }} build/install.sh\n";
const makefile = [
  "BRAND_ENV = set -a && . installer/brand.env && set +a &&",
  "build-ts:",
  "\tbun run build",
  "release: build-ts",
  "\t$(BRAND_ENV) goreleaser release --clean",
  "release-draft:",
  "\t$(BRAND_ENV) scripts/release-manifest.sh",
  "release-npm:",
  "\t$(BRAND_ENV) scripts/npm-step.sh",
  "",
].join("\n");
const scripts: Record<string, string> = {
  "scripts/release-manifest.sh": "#!/bin/sh\n# runs no npm, bun or node\njq . dist/metadata.json\n",
  "scripts/npm-step.sh": "#!/bin/sh\nset -e\ncd apps/web && npx vite build\n",
};
function fixture(job: string, goreleaser = goodGoreleaser, workflowPermissions = "permissions:\n  contents: read\n"): Sources {
  return {
    workflows: { "release.yml": `on: push\n${workflowPermissions}jobs:\n${job}` },
    goreleaser,
    makefile,
    readFile: (path) => scripts[path],
  };
}
const writeJob = (steps: string) => `  draft:\n    permissions:\n      contents: write\n    steps:\n${steps}`;
const cases: { name: string; sources: Sources; want: string | undefined }[] = [
  {
    name: "a read-only job may run bun",
    sources: fixture("  build:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n      - run: make install && bun run build\n"),
    want: undefined,
  },
  {
    name: "a write job that runs only release scripts passes",
    sources: fixture(
      writeJob("      - run: make release-draft\n      - run: |\n          # bun is not run here\n          gh release view\n"),
    ),
    want: undefined,
  },
  {
    name: "a write job may not set up bun",
    sources: fixture(writeJob("      - uses: oven-sh/setup-bun@0c5077e # v2\n")),
    want: "sets up a JavaScript runtime",
  },
  {
    name: "a write job may not run bun",
    sources: fixture(writeJob("      - run: make check-gen\n      - run: FOO=1 bun install --frozen-lockfile\n")),
    want: "runs bun",
  },
  {
    name: "a write job may not reach bun through a make prerequisite",
    sources: fixture(writeJob("      - run: make release\n")),
    want: "runs make release: its prerequisite build-ts",
  },
  {
    name: "a write job may not reach npx through a script",
    sources: fixture(writeJob("      - run: make release-npm\n")),
    want: "runs scripts/npm-step.sh: it runs npx",
  },
  {
    name: "a job with an environment is privileged",
    sources: fixture("  sign:\n    environment: release\n    steps:\n      - run: npm ci\n"),
    want: "an environment's secrets",
  },
  {
    name: "a job that names a secret is privileged",
    sources: fixture(
      `  push:\n    steps:\n      - run: bun run build\n        env:\n          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n`,
    ),
    want: "(a secret): step",
  },
  {
    name: "a job with no permissions anywhere is privileged",
    sources: fixture("  build:\n    steps:\n      - run: bun test\n", goodGoreleaser, ""),
    want: "the repository's default token permissions",
  },
  {
    name: "goreleaser hooks may not run bun",
    sources: fixture(
      "  build:\n    steps:\n      - run: true\n",
      "before:\n  hooks:\n    - bun install --frozen-lockfile\n    - scripts/render-installer.sh x\n",
    ),
    want: 'the goreleaser hook "bun install --frozen-lockfile" runs bun',
  },
  {
    name: "goreleaser build hooks may not run npm either",
    sources: fixture(
      "  build:\n    steps:\n      - run: true\n",
      "builds:\n  - id: agent\n    hooks:\n      pre:\n        - cmd: npm run build\n",
    ),
    want: "runs npm",
  },
];

let failures = 0;
for (const c of cases) {
  const problems = check(c.sources);
  const ok = c.want === undefined ? problems.length === 0 : problems.some((p) => p.includes(c.want as string));
  if (ok) {
    console.log(`ok   check: ${c.name}`);
  } else {
    failures++;
    console.log(`FAIL check: ${c.name}`);
    for (const p of problems.length ? problems : ["(no problem found)"]) console.log(`     | ${p}`);
  }
}

const root = join(import.meta.dir, "..");
const problems = check(repoSources(root));
if (problems.length === 0) {
  console.log("ok   no job that holds a write token or a secret runs bun, npm or node, and goreleaser's hooks run none");
} else {
  failures++;
  console.log("FAIL a job that holds a write token or a secret runs JavaScript tooling:");
  for (const p of problems) console.log(`     | ${p}`);
}

if (failures > 0) {
  console.log(`release workflow check: ${failures} failed`);
  process.exit(1);
}
console.log("release workflow check: all passed");

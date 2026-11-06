// Runs template code (index.ts with a generate(input) function) in a
// QuickJS WebAssembly sandbox: no filesystem, network, timers or host
// objects, a memory cap and a time limit. A Bun Worker is not a sandbox,
// so template code never runs in the panel's own JavaScript engine.
//
//   const output = await runTemplate(source, { serviceName: "n8n", ... });

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import variant from "@jitl/quickjs-wasmfile-release-sync";
// Imported as a file so `bun build` copies the wasm into dist next to
// main.js; the variant alone looks for it beside its own (bundled) module.
import wasmPath from "@jitl/quickjs-wasmfile-release-sync/wasm" with { type: "file" };
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import { checkOutput, TemplateError, type TemplateOutput } from "./output";
import { utilsModuleName, utilsSource } from "./utils";

export interface RunLimits {
  /** Wall time for loading and generate(); default 1 s. */
  timeoutMs?: number;
  /** Heap cap; default 32 MiB. */
  memoryBytes?: number;
}

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(
    // In the bundle the path is relative to dist (main.js), not to the working directory.
    newVariant(variant, { wasmBinary: async () => (await Bun.file(resolve(import.meta.dir, wasmPath)).arrayBuffer()) as ArrayBuffer }),
  );
  return modulePromise;
}

const transpiler = new Bun.Transpiler({ loader: "ts", trimUnusedImports: true, target: "browser" });

/** TypeScript -> JavaScript (types and type-only imports removed). */
export function transpile(source: string): string {
  try {
    return transpiler.transformSync(source);
  } catch (error) {
    throw new TemplateError(`index.ts does not compile: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const entryName = "__entry.js";
const templateName = "./index.js";

export async function runTemplate(source: string, input: Record<string, unknown>, limits: RunLimits = {}): Promise<TemplateOutput> {
  const code = transpile(source);
  const module = await quickjs();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes ?? 32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (limits.timeoutMs ?? 1000)));
  runtime.setModuleLoader((name) => {
    if (name === utilsModuleName) return utilsSource;
    if (name === templateName || name === "index.js" || name === "./index") return code;
    if (name === "./meta" || name === "./meta.js") return "export {};";
    throw new Error(`templates can only import ${utilsModuleName}, not ${name}`);
  });
  const vm = runtime.newContext();
  try {
    const random = vm.newFunction("__hostRandom", (n) => {
      const count = Math.min(4096, Math.max(0, Math.floor(vm.getNumber(n))));
      return vm.newString(randomBytes(count).toString("hex"));
    });
    vm.setProp(vm.global, "__hostRandom", random);
    random.dispose();
    const inputHandle = vm.newString(JSON.stringify(input));
    vm.setProp(vm.global, "__input", inputHandle);
    inputHandle.dispose();

    const entry = `import { generate } from "${templateName}";
if (typeof generate !== "function") throw new Error("index.ts must export a function named generate");
globalThis.__output = JSON.stringify(generate(JSON.parse(globalThis.__input)));`;
    const result = vm.evalCode(entry, entryName, { type: "module" });
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw new TemplateError(`generate() failed: ${describe(error)}`);
    }
    result.value.dispose();
    // Module evaluation may leave promise jobs (an async generate is not supported, but drain anyway).
    runtime.executePendingJobs();
    const out = vm.getProp(vm.global, "__output");
    const json = vm.typeof(out) === "string" ? vm.getString(out) : null;
    out.dispose();
    if (json === null) throw new TemplateError("generate() returned nothing (it must return { services: [...] } synchronously).");
    return checkOutput(JSON.parse(json));
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const e = error as { name?: string; message: string };
    if (e.message === "interrupted") return "it ran longer than the time limit";
    return `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}`;
  }
  return String(error);
}

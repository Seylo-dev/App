// `import path from "<pkg>/wasm" with { type: "file" }` gives the file's path.
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const path: string;
  export default path;
}

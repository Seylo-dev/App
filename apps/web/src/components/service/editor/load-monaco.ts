// Monaco is loaded once for the whole app. Its own module, so a route loader
// can start the download (environment.tsx) without pulling the editor
// component into the app's first bundle.

let loading: Promise<typeof import("./monaco")> | null = null;

export function loadMonaco(): Promise<typeof import("./monaco")> {
  loading ??= import("./monaco");
  return loading;
}

// A demo handler throws DemoRefusal to answer the way the panel refuses an
// op: routes.ts sends the error body with its status instead of a 200.

export class DemoRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

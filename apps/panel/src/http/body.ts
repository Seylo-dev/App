// The answer for a webhook body that readBodyText (@seylo/ops/elysia)
// refused: too large for the route, or the panel already buffers its budget
// of request bodies (try again shortly).

export function bodyRefused(reason: "tooLarge" | "busy"): Response {
  return reason === "busy"
    ? new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "The panel is busy. Try again in a few seconds." } }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      })
    : new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: "Payload too large." } }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
}

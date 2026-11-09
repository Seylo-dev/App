// Any path no other route takes: the 404 inside the signed-in layout, so a
// signed-in person keeps the sidebar (and a signed-out one goes to the
// sign-in page first, like for every screen here).

import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "../../components/not-found";

export const Route = createFileRoute("/_app/$")({
  component: NotFound,
});

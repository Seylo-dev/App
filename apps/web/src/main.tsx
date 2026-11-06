import "./index.css";
import { OpClientProvider } from "@seylo/ops/react";
import { UiLabelsProvider } from "@seylo/ui/components/labels";
import { MotionProvider } from "@seylo/ui/components/motion";
import { Toaster } from "@seylo/ui/components/toast";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReauthHost } from "./components/auth/reauth-dialog";
import { opClient, queryClient } from "./lib/api";
import { startTheme } from "./lib/theme";
import { uiLabels } from "./lib/ui-labels";
import { routeTree } from "./routeTree.gen";

const router = createRouter({
  routeTree,
  context: { queryClient, opClient },
  defaultPreload: "intent",
  // Loaders read through TanStack Query, which has its own cache.
  defaultPreloadStaleTime: 0,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

startTheme();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <OpClientProvider client={opClient}>
        <UiLabelsProvider labels={uiLabels()}>
          <MotionProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
              <Toaster />
              <ReauthHost />
            </TooltipProvider>
          </MotionProvider>
        </UiLabelsProvider>
      </OpClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Collects the op handlers of every module into one lookup table and checks
// that each handler sits in the module its op id names.

import { moduleOf } from "@seylo/ops";
import type { PanelModule } from "../modules/module";
import type { OpHandler } from "./implement";

export function collectHandlers(modules: readonly PanelModule[]): Map<string, OpHandler> {
  const handlers = new Map<string, OpHandler>();
  for (const module of modules) {
    for (const handler of module.ops) {
      const id = handler.contract.id;
      if (moduleOf(handler.contract) !== module.name) {
        throw new Error(`handler for ${id} is in module "${module.name}"; move it to modules/${moduleOf(handler.contract)}/`);
      }
      if (handlers.has(id)) throw new Error(`op ${id} has two handlers`);
      handlers.set(id, handler);
    }
  }
  return handlers;
}

// The Ports section's line about what follows the main port (the first TCP
// port) when the form changes it, as the panel moves it on save
// (services.update, panel services/port-move.ts mainPortChange): the
// domains, IP:port access and Cloudflare tunnel on the old port move to the
// new one, at once without a live version, else with the next deploy.

import { t } from "../../../i18n/t";
import type { ServiceDetail } from "../use-service";

type Port = ServiceDetail["ports"][number];

const mainPortOf = (ports: readonly Port[]) => ports.find((p) => p.protocol !== "udp" && p.containerPort > 0)?.containerPort ?? null;

/** The main port the form moves from and to; null when it stays, or the old one is still among the new ports. */
export function mainPortMove(saved: readonly Port[], form: readonly Port[]): { from: number; to: number } | null {
  const from = mainPortOf(saved);
  const to = mainPortOf(form);
  if (from === null || to === null || from === to) return null;
  if (form.some((p) => p.protocol !== "udp" && p.containerPort === from)) return null;
  return { from, to };
}

/** "What points at port 3000 ... moves to 6000 when the next deploy rolls out.", or null when nothing follows. */
export function mainPortNote(service: Pick<ServiceDetail, "ports" | "liveDeployment">, form: readonly Port[]): string | null {
  const move = mainPortMove(service.ports, form);
  if (!move) return null;
  return t(service.liveDeployment ? "serviceAdvanced.container.mainPortRollout" : "serviceAdvanced.container.mainPortNow", move);
}

// A service's volumes (ServiceDetail.volumes) and the edits the Storage tab
// makes through services.setVolumes, which replaces the whole list of named
// volumes (file mounts are not part of it and stay as they are).

import { services } from "@seylo/ops";
import type { ServiceDetail } from "../use-service";

export type Volume = ServiceDetail["volumes"][number];
export type VolumeInput = { name: string; mountPath: string; readOnly: boolean };

export function volumesOf(service: Pick<ServiceDetail, "volumes">): Volume[] {
  return service.volumes ?? [];
}

/** The named volumes as setVolumes takes them. */
export function volumeInputs(volumes: readonly Volume[]): VolumeInput[] {
  return volumes.filter((v) => v.kind === "volume").map((v) => ({ name: v.name, mountPath: v.mountPath, readOnly: v.readOnly }));
}

const namePattern = new RegExp(services.VolumeName.pattern ?? "^[a-z0-9][a-z0-9_.-]*$");

export type VolumeProblem = "nameFormat" | "nameTaken" | "pathFormat" | "pathTaken";

/** What is wrong with a new volume next to the existing ones, or null. */
export function checkNewVolume(volume: VolumeInput, existing: readonly Volume[]): VolumeProblem | null {
  if (!namePattern.test(volume.name) || volume.name.length > 60) return "nameFormat";
  if (existing.some((v) => v.name === volume.name)) return "nameTaken";
  if (!volume.mountPath.startsWith("/") || volume.mountPath.length > 500) return "pathFormat";
  if (existing.some((v) => v.mountPath.replace(/\/+$/, "") === volume.mountPath.replace(/\/+$/, ""))) return "pathTaken";
  return null;
}

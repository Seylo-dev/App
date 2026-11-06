// Every service the person can see, across projects: one services.list per
// project, sharing the cache entries the project screens use. The
// dashboard, its subtitle and the command palette read this.

import { OpError, projects, services } from "@seylo/ops";
import { opQueryKey, useOp, useOpClient } from "@seylo/ops/react";
import { useQueries } from "@tanstack/react-query";
import type { Project, ServiceSummary } from "./types";

export interface ServicesByProject {
  projects: Project[];
  /** Per project id; missing while loading or when that project's list failed. */
  services: Map<string, ServiceSummary[]>;
  /** Every loaded service with its project. */
  all: { service: ServiceSummary; project: Project }[];
  /** The first failure, for an error state (NOT_IMPLEMENTED while the services module is not built). */
  error: OpError | null;
  pending: boolean;
}

export function useAllServices(enabled = true): ServicesByProject {
  const client = useOpClient();
  const list = useOp(projects.list, {}, { enabled });
  const projectRows = list.data?.projects ?? [];
  const queries = useQueries({
    queries: projectRows.map((project) => ({
      queryKey: opQueryKey(services.list, { projectId: project.id }),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.call(services.list, { projectId: project.id }, { signal }),
      enabled,
    })),
  });

  const byProject = new Map<string, ServiceSummary[]>();
  const all: ServicesByProject["all"] = [];
  let error: OpError | null = list.error ?? null;
  queries.forEach((query, index) => {
    const project = projectRows[index];
    if (!project) return;
    if (query.data) {
      byProject.set(project.id, query.data.services);
      for (const service of query.data.services) all.push({ service, project });
    }
    if (!error && query.error instanceof OpError) error = query.error;
  });

  return {
    projects: projectRows,
    services: byProject,
    all,
    error,
    pending: list.isPending || queries.some((query) => query.isPending && query.fetchStatus !== "idle"),
  };
}

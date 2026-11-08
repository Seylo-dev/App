// Node and project pickers for create forms (new service, templates). The
// node list shows each node's status, so nobody puts a service on a node
// that is down without noticing.

import { nodes, projects } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { StatusDot } from "@seylo/ui/components/chip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { useEffect } from "react";
import { t } from "../i18n/t";
import { QueryError } from "./query-error";

export function NodePicker({ id, value, onChange }: { id: string; value: string; onChange: (nodeId: string) => void }) {
  const list = useOp(nodes.list, {});
  const options = list.data?.nodes.filter((node) => node.status !== "disabled") ?? [];
  const first = options.find((node) => node.status === "online") ?? options[0];

  // Preselect the first online node so the common case is one click.
  useEffect(() => {
    if (!value && first) onChange(first.id);
  }, [value, first, onChange]);

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <Select value={value} onValueChange={onChange} disabled={options.length === 0}>
      <SelectTrigger id={id} loading={list.isPending}>
        <SelectValue placeholder={t("pickers.noNodes")} />
      </SelectTrigger>
      <SelectContent>
        {options.map((node) => (
          <SelectItem key={node.id} value={node.id}>
            <span className="flex items-center gap-2">
              <StatusDot status={node.status === "online" ? "ok" : "off"} />
              {node.name}
              {node.wildcardDomain && <span className="font-mono text-xs text-muted-foreground">*.{node.wildcardDomain}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ProjectPicker({
  id,
  value,
  onChange,
  exclude,
}: {
  id: string;
  value: string;
  onChange: (projectId: string) => void;
  /** A project left out of the list (the one a service moves away from). */
  exclude?: string;
}) {
  const list = useOp(projects.list, {});
  const options = list.data?.projects.filter((project) => !project.protected && project.id !== exclude) ?? [];
  const first = options[0];

  useEffect(() => {
    if (!value && first) onChange(first.id);
  }, [value, first, onChange]);

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <Select value={value} onValueChange={onChange} disabled={options.length === 0}>
      <SelectTrigger id={id} loading={list.isPending}>
        <SelectValue placeholder={t("pickers.noProjects")} />
      </SelectTrigger>
      <SelectContent>
        {options.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

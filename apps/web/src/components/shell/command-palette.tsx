// Cmd+K: search projects, services and nodes, jump to any screen, or start
// an action (new project, new service, add a node). Data is loaded when
// the palette opens and comes from the same cache the screens use.

import { nodes } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { StatusDot } from "@seylo/ui/components/chip";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@seylo/ui/components/command";
import { IconBrandDocker, IconFolder, IconFolderPlus, IconLayoutGrid, IconPlus, IconServer2, IconServerBolt } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { t } from "../../i18n/t";
import { kindTag, statusDisplay } from "../../lib/service-display";
import { useAllServices } from "../../lib/use-all-services";
import { useStartNewService } from "../new-service/new-service-menu";
import { useShell } from "./shell-context";
import { useMainNav } from "./use-main-nav";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const shell = useShell();
  const startNewService = useStartNewService();
  const { items: navItems } = useMainNav();
  const nodeList = useOp(nodes.list, {}, { enabled: open, retry: false });
  const everything = useAllServices(open);
  const projectRows = everything.projects;
  const serviceRows = everything.all;

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t("palette.title")}>
      <CommandInput placeholder={t("palette.placeholder")} />
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>
        <CommandGroup heading={t("palette.actions")}>
          <CommandItem value={`action ${t("nav.newProject")}`} onSelect={() => run(shell.openNewProject)}>
            <IconFolderPlus size={16} aria-hidden="true" />
            {t("nav.newProject")}
          </CommandItem>
          <CommandItem value={`action ${t("palette.newApp")}`} onSelect={() => run(() => startNewService("app"))}>
            <IconPlus size={16} aria-hidden="true" />
            {t("palette.newApp")}
          </CommandItem>
          <CommandItem value={`action ${t("palette.newDatabase")}`} onSelect={() => run(() => startNewService("database"))}>
            <IconPlus size={16} aria-hidden="true" />
            {t("palette.newDatabase")}
          </CommandItem>
          <CommandItem value={`action ${t("palette.fromTemplate")}`} onSelect={() => run(() => startNewService("template"))}>
            <IconLayoutGrid size={16} aria-hidden="true" />
            {t("palette.fromTemplate")}
          </CommandItem>
          <CommandItem value={`action ${t("palette.fromDockerHub")}`} onSelect={() => run(() => startNewService("dockerHub"))}>
            <IconBrandDocker size={16} aria-hidden="true" />
            {t("palette.fromDockerHub")}
          </CommandItem>
          <CommandItem
            value={`action ${t("palette.addNode")}`}
            onSelect={() => run(() => void navigate({ to: "/nodes", search: { add: true } }))}
          >
            <IconServerBolt size={16} aria-hidden="true" />
            {t("palette.addNode")}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t("palette.go")}>
          {navItems.map((item) => (
            <CommandItem key={item.to} value={`go ${t(item.label)}`} onSelect={() => run(() => void navigate({ to: item.to }))}>
              <item.icon size={16} aria-hidden="true" />
              {t(item.label)}
            </CommandItem>
          ))}
        </CommandGroup>
        {projectRows.length > 0 && (
          <CommandGroup heading={t("palette.projects")}>
            {projectRows.map((project) => (
              <CommandItem
                key={project.id}
                value={`project ${project.name} ${project.id}`}
                onSelect={() => run(() => void navigate({ to: "/p/$projectId", params: { projectId: project.id } }))}
              >
                <IconFolder size={16} aria-hidden="true" />
                {project.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {serviceRows.length > 0 && (
          <CommandGroup heading={t("palette.services")}>
            {serviceRows.map(({ service, project }) => (
              <CommandItem
                key={service.id}
                value={`service ${service.name} ${project.name} ${service.id}`}
                onSelect={() =>
                  run(() => void navigate({ to: "/p/$projectId/s/$serviceId", params: { projectId: project.id, serviceId: service.id } }))
                }
              >
                <StatusDot status={statusDisplay(service.status, service.buildWaiting).dot} />
                {service.name}
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono text-[10.5px]">{kindTag(service).label}</span>
                  {project.name}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {nodeList.data && nodeList.data.nodes.length > 0 && (
          <CommandGroup heading={t("palette.nodes")}>
            {nodeList.data.nodes.map((node) => (
              <CommandItem
                key={node.id}
                value={`node ${node.name} ${node.publicIpv4 ?? ""} ${node.id}`}
                onSelect={() => run(() => void navigate({ to: "/nodes", search: { node: node.id } }))}
              >
                <IconServer2 size={16} aria-hidden="true" />
                {node.name}
                <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot status={node.status === "online" ? "ok" : "off"} />
                  {node.publicIpv4}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { t } from "../../i18n/t";
import { type DeploymentStatus, deploymentStatusLook, type ServiceStatus, type StatusLook, serviceStatusLook } from "./status";

function LookChip({ look, className }: { look: StatusLook; className?: string }) {
  return (
    <Chip tone={look.tone} className={className}>
      <StatusDot status={look.dot} pulse={look.pulse} />
      {t(look.label)}
    </Chip>
  );
}

export function ServiceStatusChip({ status, className }: { status: ServiceStatus; className?: string }) {
  return <LookChip look={serviceStatusLook[status]} className={className} />;
}

export function DeploymentStatusChip({ status, className }: { status: DeploymentStatus; className?: string }) {
  return <LookChip look={deploymentStatusLook[status]} className={className} />;
}

import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { t } from "../../i18n/t";
import { type DeploymentStatus, deploymentLook, type ServiceStatus, type StatusLook, serviceLook } from "./status";

function LookChip({ look, className }: { look: StatusLook; className?: string }) {
  return (
    <Chip tone={look.tone} className={className}>
      <StatusDot status={look.dot} pulse={look.pulse} />
      {t(look.label)}
    </Chip>
  );
}

/** buildWaiting: the deploy's build waits for a free build slot (ServiceSummary.buildWaiting). */
export function ServiceStatusChip({
  status,
  buildWaiting,
  className,
}: {
  status: ServiceStatus;
  buildWaiting?: boolean;
  className?: string;
}) {
  return <LookChip look={serviceLook(status, buildWaiting)} className={className} />;
}

/** buildWaiting: the build waits for a free build slot (Deployment.buildWait set). */
export function DeploymentStatusChip({
  status,
  buildWaiting,
  className,
}: {
  status: DeploymentStatus;
  buildWaiting?: boolean;
  className?: string;
}) {
  return <LookChip look={deploymentLook(status, buildWaiting)} className={className} />;
}

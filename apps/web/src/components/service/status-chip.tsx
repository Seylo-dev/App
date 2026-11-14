import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { t } from "../../i18n/t";
import { type DeploymentStatus, type DotSource, deploymentLook, type StatusLook, serviceChipLook } from "./status";

function LookChip({ look, className }: { look: StatusLook; className?: string }) {
  return (
    <Chip tone={look.tone} className={className}>
      <StatusDot status={look.dot} pulse={look.pulse} />
      {t(look.label)}
    </Chip>
  );
}

/**
 * A service's status: the label says what a deploy does (building, waiting
 * for a build slot, deploying), the dot whether it is up (serviceDot).
 */
export function ServiceStatusChip({ service, className }: { service: DotSource; className?: string }) {
  return <LookChip look={serviceChipLook(service)} className={className} />;
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

// The stack in a compose member's breadcrumb: "shop / monitoring / grafana".

import { services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { SkeletonText } from "@seylo/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import { retryOp } from "./op-state";

/** The parent stack's name, a placeholder while services.get answers, its id only when that fails. */
export function ParentCrumb({ projectId, parentId }: { projectId: string; parentId: string }) {
  const parent = useOp(services.get, { serviceId: parentId }, { retry: retryOp });
  return (
    <>
      <span aria-hidden="true">/</span>
      <Link to="/p/$projectId/s/$serviceId" params={{ projectId, serviceId: parentId }} className="text-muted-foreground">
        {parent.data?.name ?? (parent.isPending ? <SkeletonText ground className="w-16" /> : parentId)}
      </Link>
    </>
  );
}

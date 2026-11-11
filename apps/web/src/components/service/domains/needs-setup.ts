// Which of a service's domains still need the owner: the Domains tab shows
// their count in red. A custom domain needs setup while its DNS record is
// missing or points elsewhere, while requests through Cloudflare's proxy do
// not reach the service's node yet, or when its certificate failed.
// Automatic domains (the node's wildcard record) and forwards never count,
// and a certificate on its way (pending) is not the owner's job.

import type { domains, OpOutput } from "@seylo/ops";

type Domain = OpOutput<typeof domains.list>["domains"][number];

export function domainNeedsSetup(d: Domain): boolean {
  if (d.auto || d.forward) return false;
  if (d.dnsStatus === "missing" || d.dnsStatus === "wrongTarget") return true;
  if (d.origin === "elsewhere") return true;
  if (d.dnsStatus === "proxied" && d.origin !== "node") return true;
  return d.certificate.status === "failed";
}

export function domainsNeedingSetup(list: readonly Domain[] | undefined): number {
  return list ? list.filter(domainNeedsSetup).length : 0;
}

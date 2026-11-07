// GitHub's webhook delivery addresses, for the App webhook's limit on
// refused deliveries. GitHub sends every user's repository and App webhooks
// from these few ranges, so a bucket keyed on one of them is shared with
// anyone who points a webhook of their own at this panel: their refused
// deliveries would use up the bucket and get the panel's own signed
// deliveries refused unread (GitHub Apps do not retry). Deliveries from
// these ranges are therefore always read and verified; what they cost is
// bounded by the 5 MiB body cap, the shared body budget and GitHub's own
// delivery rate.
//
// Source: the `hooks` list of https://api.github.com/meta, checked
// 2026-11-08. The list changes rarely; an address missing here only means
// its refused deliveries count against that address, as for any other
// sender.

import { type Cidr, inRanges, parseCidr } from "../../http/ip-ranges";

const ranges: readonly Cidr[] = [
  "192.30.252.0/22",
  "185.199.108.0/22",
  "140.82.112.0/20",
  "143.55.64.0/20",
  "9.234.106.48/28",
  "9.234.98.160/28",
  "9.234.98.176/28",
  "2a0a:a440::/29",
  "2606:50c0::/32",
].map(parseCidr);

export function isGithubHookAddress(address: string): boolean {
  return inRanges(address, ranges);
}

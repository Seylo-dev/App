// The country header in the desired state: NodeSettings.country_header for
// every node (with the MaxMind account when one is set), and
// Routing.no_country_header for a service that turned it off. After the
// networking contributor, which builds Routing.

import { create } from "@bufbuild/protobuf";
import { CountryHeaderSchema } from "@seylo/proto";
import type { DesiredContributor } from "../../desired/contributors";
import { readSpec } from "../services/spec";
import { maxmindAccount, readCountryHeader } from "./settings";

export const countryHeaderContributor: DesiredContributor = {
  name: "countryHeader",
  // After networking (0), before the panel's own service (1000).
  order: 10,
  service({ service, spec }) {
    if (spec.routing) spec.routing.noCountryHeader = !readSpec(service.spec).countryHeader;
  },
  node({ db, secrets, settings }) {
    const stored = readCountryHeader(db);
    const account = stored.enabled ? maxmindAccount(db, secrets) : null;
    settings.countryHeader = create(CountryHeaderSchema, {
      enabled: stored.enabled,
      maxmindAccountId: account?.accountId ?? "",
      maxmindLicenseKey: account?.licenseKey ?? "",
    });
  },
};

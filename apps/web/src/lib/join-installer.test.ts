// During the 0.2.1 release candidates the join command runs the 0.2.0
// installer (the install host serves the latest stable one), which does
// not install Docker without asking. Add node said it did.

import { expect, test } from "bun:test";
import { joinInstallsDocker } from "./join-installer";

test("released panels and pre-releases after 0.2.1 get an installer that installs Docker", () => {
  for (const v of ["0.2.1", "v0.2.1", "0.2.2", "0.3.0", "1.0.0", "0.2.2-rc.1", "0.3.0-beta.2", "1.0.0-rc.1", "dev", ""]) {
    expect({ v, installs: joinInstallsDocker(v) }).toEqual({ v, installs: true });
  }
});

test("a 0.2.1 pre-release (or an older one) gets the 0.2.0 installer, which asks first", () => {
  for (const v of ["0.2.1-rc.1", "v0.2.1-rc.4", "0.2.1-SNAPSHOT-abc1234", "0.2.1-rc.1-5-gabc1234", "0.2.0-rc.2", "0.1.9-rc.1"]) {
    expect({ v, installs: joinInstallsDocker(v) }).toEqual({ v, installs: false });
  }
});

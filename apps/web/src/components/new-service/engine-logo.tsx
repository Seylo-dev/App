// A database engine's logo for the New database form, on the light logo
// tile the template catalog uses, the same size as the letter badge it
// replaces. Logos are bundled from ./logos (dashboard-icons at the commit
// in templates/NOTICE); KeyDB and Dragonfly have none there, so they keep
// their letter badge.

import type { databases } from "@seylo/ops";
import { KindBadge } from "./kinds";
import clickhouseLogo from "./logos/clickhouse.svg";
import mariadbLogo from "./logos/mariadb.svg";
import mongodbLogo from "./logos/mongodb.svg";
import mysqlLogo from "./logos/mysql.svg";
import postgresqlLogo from "./logos/postgresql.svg";
import redisLogo from "./logos/redis.svg";
import valkeyLogo from "./logos/valkey.svg";

type Engine = (typeof databases.DatabaseEngine)["static"];

export const engineLogos: Partial<Record<Engine, string>> = {
  postgres: postgresqlLogo,
  mysql: mysqlLogo,
  mariadb: mariadbLogo,
  mongo: mongodbLogo,
  redis: redisLogo,
  valkey: valkeyLogo,
  clickhouse: clickhouseLogo,
};

/** The engine's logo tile, else its letter badge (tag). Hidden from screen readers: the name is written next to it. */
export function EngineLogo({ engine, tag }: { engine: Engine; tag: string }) {
  const logo = engineLogos[engine];
  if (!logo) return <KindBadge tag={tag} tone="sky" />;
  return (
    <span
      aria-hidden="true"
      data-engine-logo={engine}
      className="flex h-[26px] w-9 shrink-0 items-center justify-center rounded-chip bg-logo-tile px-1.5 py-1"
    >
      <img src={logo} alt="" className="size-full object-contain" />
    </span>
  );
}

// The Exposed card's note while the port serves a self-signed certificate
// (databases.get exposure.selfSignedReason, 0.2.12): what it means, why
// (no TLS host name, no Let's Encrypt certificate for it yet with the
// node's last ACME error, or MariaDB's own), how to get a trusted one, the
// client settings that connect meanwhile for the engine, and the
// certificate to trust when the node reports it.

import type { databases, OpOutput } from "@seylo/ops";
import { Callout } from "@seylo/ui/components/alert";
import { t } from "../../../i18n/t";
import { downloadText } from "../deploy-log";

type Db = OpOutput<typeof databases.get>;

export function SelfSignedNote({ db, serviceName }: { db: Db; serviceName: string }) {
  const e = db.exposure;
  const reason = e.selfSignedReason;
  if (!reason) return null;
  const host = e.tlsHostname ?? "";
  const pem = e.certificatePem;
  return (
    <Callout tone="info" title={t("serviceDatabase.selfSigned.title")} className="text-[12.5px]">
      <p className="m-0">
        {t("serviceDatabase.selfSigned.body")} {t(`serviceDatabase.selfSigned.reason.${reason}`, { host })}
        {e.certificateError ? ` ${t("serviceDatabase.selfSigned.lastError", { error: e.certificateError })}` : ""}
      </p>
      {reason !== "engine" && (
        <p className="m-0 mt-1">
          {reason === "acmeMissing" ? t("serviceDatabase.selfSigned.fixAcme", { host }) : t("serviceDatabase.selfSigned.getTrusted")}
        </p>
      )}
      <p className="m-0 mt-1">
        {meanwhile(db)}
        {pem && (
          <>
            {" "}
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 font-medium text-current underline"
              onClick={() => downloadText(`${serviceName}.crt`, pem)}
            >
              {t("serviceDatabase.selfSigned.download")}
            </button>{" "}
            {downloadHint(db)}
          </>
        )}
      </p>
    </Callout>
  );
}

/**
 * How to trust the downloaded file. With a TLS host name the fallback
 * names it, so any client that checks certificates connects by it; without
 * one it names no host, so only the clients that skip the name check do
 * (libpq verify-ca, MySQL VERIFY_CA, Mongo tlsAllowInvalidHostnames).
 */
function downloadHint(db: Db): string {
  const host = db.exposure.tlsHostname;
  if (host) return t("serviceDatabase.selfSigned.downloadHint", { host });
  switch (db.engine) {
    case "postgres":
    case "mysql":
    case "mongo":
      return t(`serviceDatabase.selfSigned.downloadHintNoHost.${db.engine}`);
    default:
      return t("serviceDatabase.selfSigned.downloadHintNoHost.other");
  }
}

/**
 * The client settings that connect to a self-signed certificate, per
 * engine. Without a TLS host name the exposed URL already carries Mongo's
 * and ClickHouse's (databases/info.ts selfSignedParam).
 */
function meanwhile(db: Db): string {
  const inUrl = db.exposure.tlsHostname === null;
  switch (db.engine) {
    case "postgres":
    case "mysql":
    case "mariadb":
      return t(`serviceDatabase.selfSigned.meanwhile.${db.engine}`);
    case "mongo":
      return t(inUrl ? "serviceDatabase.selfSigned.meanwhile.mongoInUrl" : "serviceDatabase.selfSigned.meanwhile.mongo");
    case "clickhouse":
      return t(inUrl ? "serviceDatabase.selfSigned.meanwhile.clickhouseInUrl" : "serviceDatabase.selfSigned.meanwhile.clickhouse");
    default:
      return t("serviceDatabase.selfSigned.meanwhile.redis");
  }
}

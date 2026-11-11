// README.txt, the first entry of every export file.

import { displayName } from "@seylo/brand";

export function readmeText(input: { name: string; secrets: "encrypted" | "omitted"; upload: boolean; panelVersion: string }): string {
  const lines = [
    `${displayName} service export: ${input.name}`,
    "",
    `Written by ${displayName} ${input.panelVersion}. To import it, open a project on any ${displayName} panel,`,
    "choose New service > Import from a file and pick this .zip as it is (do not unzip and zip it again).",
    "",
    "What is inside",
    "",
    "  manifest.json   the format version, and the size and SHA-256 of every other file here",
  ];
  if (input.secrets === "encrypted") {
    lines.push(
      "  manifest.sig    an HMAC of manifest.json made with your passphrase",
      "  secrets.enc     the service's settings and secret values (environment variables, file",
      "                  mounts, database logins, certificates), encrypted with your passphrase",
      "                  (scrypt, AES-256-GCM). Without the passphrase nobody can open it.",
    );
  } else {
    lines.push(
      `  services/${input.name}/service.json`,
      "                  every setting, in clear. Commands, URLs, host names and notes are as they",
      "                  were; secret values (environment variable values, file mounts, database",
      "                  logins, certificates) were left out.",
    );
  }
  if (input.upload) {
    lines.push(`  services/${input.name}/source/upload.tar.gz`, "                  the newest archive uploaded as the service's code");
  }
  lines.push(
    "",
    "Not encrypted, whatever you picked: the uploaded archive and volume data. Keep the file",
    "where you would keep the service's code and data.",
    "",
    "Large files: use unzip or 7-Zip to look inside; some built-in zip tools fail on files",
    "over 4 GB.",
    "",
  );
  return lines.join("\n");
}

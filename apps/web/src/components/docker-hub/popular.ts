// The "Popular images" row on the Templates page: apps that run from one
// Docker Hub image with no database to set up first. Each opens the same
// prefilled form as a search result; the presets fill in what the image
// itself does not say: the web UI's port when it EXPOSEs several, where it
// keeps its data when it declares no VOLUME, a setting that puts its
// database file there. Logos are bundled from ./logos (dashboard-icons,
// see the NOTICE there); RustFS has only a wordmark there, so it keeps its
// letter tile.

import type { MessageKey } from "../../i18n/t";
import excalidrawLogo from "./logos/excalidraw.svg";
import giteaLogo from "./logos/gitea.svg";
import grafanaLogo from "./logos/grafana.svg";
import mailpitLogo from "./logos/mailpit.svg";
import memosLogo from "./logos/memos.webp";
import metabaseLogo from "./logos/metabase.svg";
import n8nLogo from "./logos/n8n.svg";
import nginxLogo from "./logos/nginx.svg";
import nodeRedLogo from "./logos/node-red.svg";
import uptimeKumaLogo from "./logos/uptime-kuma.svg";
import vaultwardenLogo from "./logos/vaultwarden.svg";

export interface PopularImage {
  id: string;
  repository: string;
  name: string;
  description: MessageKey;
  /** The app's logo (a bundled asset URL); the letter tile without one. */
  logo?: string;
  port?: number;
  /** Data folders the image does not declare as VOLUME. */
  volumes?: string[];
  env?: Record<string, string>;
}

export const popularImages: readonly PopularImage[] = [
  { id: "nginx", repository: "nginx", name: "nginx", description: "dockerHub.popularImages.nginx", logo: nginxLogo },
  {
    id: "uptime-kuma",
    repository: "louislam/uptime-kuma",
    name: "Uptime Kuma",
    description: "dockerHub.popularImages.uptimeKuma",
    logo: uptimeKumaLogo,
    volumes: ["/app/data"],
  },
  {
    id: "n8n",
    repository: "n8nio/n8n",
    name: "n8n",
    description: "dockerHub.popularImages.n8n",
    logo: n8nLogo,
    volumes: ["/home/node/.n8n"],
  },
  { id: "gitea", repository: "gitea/gitea", name: "Gitea", description: "dockerHub.popularImages.gitea", logo: giteaLogo, port: 3000 },
  {
    id: "metabase",
    repository: "metabase/metabase",
    name: "Metabase",
    description: "dockerHub.popularImages.metabase",
    logo: metabaseLogo,
    volumes: ["/metabase-data"],
    env: { MB_DB_FILE: "/metabase-data/metabase.db" },
  },
  {
    id: "grafana",
    repository: "grafana/grafana",
    name: "Grafana",
    description: "dockerHub.popularImages.grafana",
    logo: grafanaLogo,
    volumes: ["/var/lib/grafana"],
  },
  // MinIO no longer publishes images on Docker Hub; RustFS is the S3-compatible one that does.
  { id: "rustfs", repository: "rustfs/rustfs", name: "RustFS", description: "dockerHub.popularImages.rustfs", port: 9001 },
  {
    id: "mailpit",
    repository: "axllent/mailpit",
    name: "Mailpit",
    description: "dockerHub.popularImages.mailpit",
    logo: mailpitLogo,
    port: 8025,
  },
  {
    id: "vaultwarden",
    repository: "vaultwarden/server",
    name: "Vaultwarden",
    description: "dockerHub.popularImages.vaultwarden",
    logo: vaultwardenLogo,
  },
  {
    id: "node-red",
    repository: "nodered/node-red",
    name: "Node-RED",
    description: "dockerHub.popularImages.nodeRed",
    logo: nodeRedLogo,
    volumes: ["/data"],
  },
  {
    id: "excalidraw",
    repository: "excalidraw/excalidraw",
    name: "Excalidraw",
    description: "dockerHub.popularImages.excalidraw",
    logo: excalidrawLogo,
  },
  { id: "memos", repository: "neosmemo/memos", name: "Memos", description: "dockerHub.popularImages.memos", logo: memosLogo },
];

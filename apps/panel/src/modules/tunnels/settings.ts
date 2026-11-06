// Settings keys of the tunnels module.

declare module "../../settings" {
  interface SettingValues {
    /** Global Cloudflare tunnel token, sealed with purpose "cloudflare.tunnel". updatedAt in ms. */
    cloudflareTunnelToken: { tokenSealed: string; updatedAt: number };
  }
}

export {};

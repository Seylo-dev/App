// Settings keys of the maintenance module.

declare module "../../settings" {
  interface SettingValues {
    /** Panel-wide maintenance mode and the global page; html null = built-in page. updatedAt in ms. */
    maintenanceGlobal: { enabled: boolean; message: string; html: string | null; updatedAt: number };
  }
}

export {};

import { uninstallAddon } from "../install/addonInstaller.js";

export async function uninstallProject(project: string): Promise<void> {
  await uninstallAddon(project);
}

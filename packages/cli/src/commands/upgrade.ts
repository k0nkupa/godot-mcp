import { upgradeAddon } from "../install/addonInstaller.js";

export async function upgradeProject(project: string, source: string): Promise<void> {
  await upgradeAddon(project, source);
}

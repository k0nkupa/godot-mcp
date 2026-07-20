import { upgradeAddon } from "../install/addonInstaller.js";

export async function upgradeProject(project: string, source: string) {
  return upgradeAddon(project, source);
}

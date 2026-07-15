import { setPluginState } from "../install/pluginState.js";

export async function disableAddon(project: string, godotBin?: string): Promise<void> {
  await setPluginState(project, "disable", godotBin);
}

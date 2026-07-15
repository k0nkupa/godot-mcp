import { installAddon } from "../install/addonInstaller.js";
import { runDoctor, type DoctorReport } from "../install/doctor.js";
import { setPluginState } from "../install/pluginState.js";

export async function initProject(
  project: string,
  sourceDir: string,
  godotBin?: string,
): Promise<DoctorReport> {
  const install = await installAddon(project, sourceDir);
  await setPluginState(install.projectRoot, "enable", godotBin);
  return runDoctor(install.projectRoot);
}

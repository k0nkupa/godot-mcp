import { runDoctor, type DoctorReport } from "../install/doctor.js";

export async function doctorProject(project: string): Promise<DoctorReport> {
  return runDoctor(project);
}

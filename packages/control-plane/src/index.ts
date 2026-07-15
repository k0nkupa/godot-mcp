export { GodotMcpException } from "./errors.js";
export {
  ProjectConfigSchema,
  createProjectConfig,
  type ProjectConfig,
} from "./project/projectConfig.js";
export {
  discoverProject,
  readProjectIdentity,
  type DiscoveredProject,
} from "./project/projectIdentity.js";
export { resolveProjectPath, type ProjectPathMode } from "./project/pathPolicy.js";
export {
  CORE_CAPABILITIES_POLICY,
  CORE_DOCTOR_POLICY,
  CORE_HELP_POLICY,
  CORE_SESSION_POLICY,
  PHASE_ONE_POLICIES,
  expandPermissionTiers,
  visibleCapabilities,
  type CommandPolicy,
  type SessionGrants,
} from "./policy/capabilities.js";
export { authorize } from "./policy/authorize.js";
export { redactAuditValue } from "./audit/redact.js";
export {
  JsonlAuditSink,
  type AuditInput,
  type AuditSink,
} from "./audit/jsonlAuditSink.js";

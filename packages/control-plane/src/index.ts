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
  CORE_CAPTURE_POLICY,
  CORE_DOCTOR_POLICY,
  CORE_HELP_POLICY,
  CORE_POLICIES,
  CORE_QUERY_POLICY,
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
  EvidenceStore,
  type EvidenceReference,
  type PngEvidenceMetadata,
} from "./evidence/evidenceStore.js";
export {
  JsonlAuditSink,
  type AuditInput,
  type AuditSink,
} from "./audit/jsonlAuditSink.js";
export { ensureRuntimeDirectory, runtimeDirectoryPath } from "./auth/runtimeDirectory.js";
export {
  PairingDescriptorSchema,
  consumePairingDescriptor,
  createPairingDescriptor,
  type PairingMaterial,
  type SessionDescriptor,
} from "./auth/pairingDescriptor.js";
export {
  EnvelopeVerifier,
  deriveSessionKey,
  envelopeSigningText,
  signEnvelope,
  verifyEnvelope,
  type EnvelopeVerificationOptions,
  type UnsignedBridgeEnvelope,
} from "./auth/sessionCrypto.js";
export {
  getCoreHelp,
  type CoreHelp,
  type CoreHelpTopic,
} from "./help/coreHelp.js";
export {
  SessionService,
  type CapabilitySummary,
  type DoctorCheck,
  type DoctorResult,
  type PublicAttachment,
  type PublicSessionSnapshot,
  type SessionState,
} from "./session/sessionService.js";

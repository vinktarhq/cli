/**
 * Programmatic API, for build scripts that would rather call a function than shell out.
 */
export { run, parse, VERSION } from './cli.js';
export { inject, audit, type InjectResult, type AuditResult, type AuditEntry } from './commands/inject.js';
export { upload, type UploadCommandOptions, type UploadSummary, type StoredMap } from './commands/upload.js';
export { doctor, type DoctorOptions } from './commands/doctor.js';
export { resolvePosition, type ResolveResult, type Position } from './commands/resolve.js';
export { resolve as resolveConfig, type Resolved, type Sources } from './config.js';
export { loadDotEnv, type DotEnv } from './env.js';
export { matches as globMatches } from './glob.js';
export {
  deriveDebugId,
  registrationSnippet,
  isDebugId,
  REGISTRY_GLOBAL,
  MARKER_GLOBAL,
} from './debug-id.js';
export { discover, isEmptyMap, type Artifact, type Discovery } from './discover.js';
export { toUrl, normalise } from './url.js';
export { UploadError, rewrite, type UploadOptions, type UploadResult, type Limits } from './upload.js';
export {
  MAX_FILE_BYTES,
  MAX_NAME_BYTES,
  MAX_REQUEST_BYTES,
  RECOMMENDED_BATCH_BYTES,
  REQUIRED_SCOPE,
  DEFAULT_HOST,
} from './limits.js';
export {
  detectRelease,
  disabled,
  environmentWarnings,
  session,
  finish,
  type BundlerOptions,
  type Session,
} from './bundler/core.js';

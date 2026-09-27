export { runAudit, type AuditOptions, type AuditProgress } from './core/audit.js';
export { writeJsonReport } from './report/json.js';
export type * from './core/types.js';
export { detectDuplicates } from './core/duplicates.js';
export { inspectImages, type InspectOptions } from './core/inspect.js';
export { buildMediaHealth, InvalidAllowedDomainError, matchesAllowedDomain, parseAllowedDomain } from './core/health.js';

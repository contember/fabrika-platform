// @fabrika/platform — the ports every runtime-specific implementation must satisfy, plus the
// implementations that need nothing BUT those ports.
//
// The rule is not "types only" — it is: NO runtime-specific imports and NO I/O primitives of its own.
// Nothing here may import `cloudflare:workers`, `bun:*`, or `node:*`; nothing here may open a socket,
// touch a filesystem, or reach for a global that only one runtime has. A portable implementation
// written purely against a port (`SqlDeployLocks` over `SqlDatabase`) is runtime-neutral by
// construction and belongs here — keeping one copy instead of one per runtime is the whole point.
// Runtime-specific implementations live with the workers that use them, or in @fabrika/platform-node.

export { SqlDeployLocks, type SqlDeployLocksOptions } from './deploy-locks-sql'
export type { AssetServer, BlobStore, DeployLocks, JobQueue, WaitUntil } from './ports'
export type { SqlDatabase, SqlQueryResult, SqlRunResult, SqlStatement } from './sql'

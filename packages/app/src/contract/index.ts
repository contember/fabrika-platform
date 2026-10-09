// @fabrika/app/contract — the contract of an application: `defineContract`, `compileContract`, the artifact
// parser, and the IAM schema it compiles to. Browser-safe: no server runtime, no Node or Bun API.
export { contractArtifactSchema, parseContractArtifact, schemaShapeSchema } from './artifact-schema'
export { buildArtifact } from './build'
export { compileContract, describeContract } from './compile'
export {
	type ConnectSnapshot,
	describeSnapshot,
	exportDescription,
	exportDescriptionSchema,
	incompatibleChanges,
	parseExportDescription,
	type SnapshotProcedure,
} from './connect'
export * from './declaration'
export * from './defaults'
export * from './define'
export { schemaFromContract } from './platform'
export { ContractError } from './problems'
export { SNAPSHOT_DIRECTORY, type SnapshotNames, snapshotNames, snapshotSource } from './snapshot-source'

// @fabrika/app/contract — the contract of an application: `defineContract`, `compileContract`, the artifact
// parser, and the gates and IAM schema it compiles to. Browser-safe: no server runtime, no Node or Bun API.
export { contractArtifactSchema, parseContractArtifact } from './artifact-schema'
export { buildArtifact } from './build'
export { compileContract, describeContract } from './compile'
export * from './declaration'
export * from './defaults'
export * from './define'
export { schemaFromContract } from './platform'
export { ContractError } from './problems'

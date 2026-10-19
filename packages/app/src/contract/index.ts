// @fabrika/app/contract — the contract of an application: the staged kit (`defineVocabulary`, `defineApp`, its
// groups), `defineContract`, `compileContract`, the artifact parser, and the IAM schema it compiles to. Browser-safe:
// no server runtime, no Node or Bun API.
export { contractArtifactSchema, parseContractArtifact, schemaShapeSchema } from './artifact-schema'
export {
	type Attachment,
	attachment,
	type AttachmentBrand,
	type AttachmentMark,
	attachmentOf,
	type AttachmentOptions,
	attachmentOutput,
} from './attachment'
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
export type * from './context'
export * from './declaration'
export * from './defaults'
export * from './define'
export { type ClientInput, file, type FileBrand, type FileMark, fileOf, type FileRef, type FileSchema, type FileStatus } from './file'
export type * from './group'
export * from './kit'
export { schemaFromContract } from './platform'
export { ContractError } from './problems'
export { type Redirect, redirect, type RedirectBrand, type RedirectMark, redirectOf, type RedirectOptions } from './redirect'
export { SNAPSHOT_DIRECTORY, type SnapshotNames, snapshotNames, snapshotSource } from './snapshot-source'
export {
	SIGNED_TOKEN_MAX_LENGTH,
	signedToken,
	type SignedTokenMark,
	signedTokenOf,
	type SignedTokenSchema,
	token,
	TOKEN_MAX_DAYS,
	type TokenOptions,
	type TokenPurpose,
	type TokenPurposes,
	type TokenSigning,
	type WithClaims,
} from './token'
export * from './vocabulary'
export { type WebhookBindings, WebhookSecret } from './webhook-binding'

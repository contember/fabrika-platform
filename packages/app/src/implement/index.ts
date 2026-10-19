// @fabrika/app/implement — serving a contract: `serve` binds the handlers its endpoints carry, `boot` (called only by
// the generated entrypoint, through a runtime adapter) serves it. Imports `node:async_hooks`, so it is not browser-safe.
// `implement` (a mirrored handler tree) is the framework's own test entry, `./implement`, and no application's.
export {
	EmailDeliveryError,
	type EmailDeliveryErrorCode,
	type EmailDeliveryOutcome,
	type EmailDeliveryResult,
	type EmailSender,
	type EmailSenderCapabilities,
	mayRetryDelivery,
} from '@fabrika/email'
export type { FileCollectionHandle, FileCollectionReader, FileListing, ListedFile, OpenedFile } from '../files/handle'
export { FILE_SWEEP_JOB } from '../files/kinds'
export {
	FILE_SCAN_JOB,
	type FileScanner,
	SCAN_LIMITS,
	type ScanBatchResult,
	type ScanFailure,
	type ScanObject,
	type ScanVerdict,
} from '../files/scan'
export { crashEnvelope, type OperationsReport, type OperationsReporter, reportEnvelope } from '../jobs/report'
export { type ContractJobs, type JobClock, JobError, type JobFailureCode, type JobRunOptions, type JobRunResult } from '../jobs/runner'
export { secretScrubber } from '../jobs/scrub'
export type { AppMail, AppMailMessage, JobContext, JobHandler, JobHandlersOf, JobPrincipal } from '../jobs/types'
export { LINK_BOOTSTRAP_SCRIPT } from './anonymous'
export { boot, BootError, type BootOptions, type ContractApp, type IamKeySource } from './boot'
export { readBoundedBytes, REQUEST_BUDGET_MS } from './bounded'
export { AppCapability, CapabilityRefusedError, Ref, Within } from './capability'
export { CHALLENGE_LIMITS, type ChallengeFetch, TURNSTILE_VERIFY_URL } from './challenge'
export { type ConnectFailure, type ConnectFetch, type ConnectResult, type ConnectVariables, connectVariables, isJsonMediaType } from './connect'
export type { SpaAssets } from './dispatch'
export { type CapturedEnvironment, captureEnvironment } from './environment'
export type { ApplicationEnvironment, ContractDatabase, ContractImplementation, DepsRuntime, ImplementationDatabase } from './implement'
export { isContractImplementation } from './implement'
export type {
	ApplicationDirectory,
	ApplicationMember,
	ApplicationMemberPage,
	ApplicationMemberRole,
	AssignedMember,
	DirectoryMember,
	IssuedLink,
	LinkIssuing,
	Member,
	MemberDirectory,
	MemberList,
	MemberLookup,
	MemberManagement,
	MemberTarget,
} from './membership'
export type { AppPrincipal, LinkHolder, Principal, PrincipalOf, PublicPrincipal, ServicePrincipal, UserPrincipal } from './principal'
export { type AppDeps, defineDeps, serve, type ServeOptions } from './serve'
export type {
	AccessContext,
	ConnectCall,
	ConnectContext,
	ConnectSnapshots,
	ContractContext,
	ExactHandlers,
	Handler,
	HandlerInput,
	HandlersOf,
	RequestClient,
	RequestContext,
	WebhookHandler,
} from './types'
export type { WebhookDelivery, WebhookPrincipal } from './webhook'
export { issuerWorkloadTokens, type WorkloadTokenSource } from './workload'

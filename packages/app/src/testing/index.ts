// @fabrika/app/testing — test helpers with no test-runner dependency: the contract application test kit.

import { refuseInProduction } from '@fabrika/db/production'

refuseInProduction('@fabrika/app/testing')
export type { IamMembershipRpc } from '@fabrika/auth-core'
export type { FileScanner } from '../files/scan'
export type { ChallengeFetch } from '../implement/challenge'
export type { HandlerErrorSink } from '../jobs/runner'
export type {
	LabelledTestCaller,
	LinkTestCaller,
	PersonTestCaller,
	TestCaller,
	TestCallerKind,
	TestCallerOptions,
	TestGrant,
	TestLink,
	TestScope,
} from './caller'
export { passingChallenge } from './challenge'
export {
	DEV_OUTBOX_ORIGIN,
	type DevKit,
	devKit,
	type DevLink,
	type DevOutboxMessage,
	type DevOutside,
	type DevPersona,
	type DevScopeValue,
	type DevSeed,
	type DevSeedResult,
} from './dev'
export { type JobName, TEST_ENVIRONMENT, TEST_ISSUER, type TestConnection, type TestKit, testKit, type TestKitOptions } from './kit'
export type { SentInvitation, TestMembership } from './membership'
export { statusOf } from './status'

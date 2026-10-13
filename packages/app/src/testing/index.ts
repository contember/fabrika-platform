// @fabrika/app/testing — test helpers with no test-runner dependency: the contract application test kit.

import { refuseInProduction } from '@fabrika/db/production'

refuseInProduction('@fabrika/app/testing')
export type { IamMembershipRpc } from '@fabrika/auth-core'
export type { FileScanner } from '../files/scan'
export type { ChallengeFetch } from '../implement/challenge'
export type { LabelledTestCaller, LinkTestCaller, TestCaller, TestCallerKind, TestCallerOptions, TestGrant, TestLink, TestScope } from './caller'
export { type JobName, TEST_ENVIRONMENT, TEST_ISSUER, type TestConnection, type TestKit, testKit, type TestKitOptions } from './kit'

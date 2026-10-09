// @fabrika/app/testing — test helpers with no test-runner dependency: the contract application test kit.

import { refuseInProduction } from '@fabrika/db/production'

refuseInProduction('@fabrika/app/testing')
export type { TestCaller, TestCallerKind, TestCallerOptions, TestGrant, TestScope } from './caller'
export { TEST_ENVIRONMENT, TEST_ISSUER, type TestConnection, type TestKit, testKit, type TestKitOptions } from './kit'

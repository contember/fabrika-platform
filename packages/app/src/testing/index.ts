// @fabrika/app/testing — test helpers with no test-runner dependency: the contract application test kit, and the
// cross-runtime conformance helper of `defineApp()` services.

import { refuseInProduction } from '@fabrika/db/production'

refuseInProduction('@fabrika/app/testing')
export type { TestCaller, TestCallerKind, TestCallerOptions, TestGrant, TestScope } from './caller'
export {
	type AppRuntimeConformanceOptions,
	type AppRuntimeResponses,
	type AppTestRuntime,
	assertAppRuntimeConformance,
	normalizeAppResponse,
	type NormalizedAppResponse,
	runAppRuntimeConformance,
} from './conformance'
export { TEST_ENVIRONMENT, TEST_ISSUER, type TestKit, testKit, type TestKitOptions } from './kit'

// @fabrika/app/testing/isolation — the leak sweep an application opts into with one call, and the kits behind it and
// behind fabrika's own enforcement tests: the policy isolation kit and the endpoint access kit. A subpath of its own: it
// loads `@fabrika/db/testing`, which needs Bun and Postgres.

import { refuseInProduction } from '@fabrika/db/production'

refuseInProduction('@fabrika/app/testing/isolation')

export { GENERATED_MEMBER, GENERATED_ROW_PREFIX } from '../contract/defaults'
export {
	type DeniedOutcome,
	type EndpointAccessKit,
	endpointAccessKit,
	type EndpointAccessOptions,
	type LeakOutcome,
	type ReachOutcome,
	type SweepOutcome,
} from './endpoint-access'
export { leakSweep, type LeakSweepOptions } from './leak-sweep'
export {
	type AppCaller,
	type AppCountOutcome,
	type AppIsolationKit,
	appPolicyIsolationKit,
	type ChildIsolationRow,
	type CountOutcome,
	type IsolationOutcome,
	type IsolationRow,
	type ListOutcome,
	type MisuseOutcome,
	type PolicyIsolationKit,
	policyIsolationKit,
	type ReadOutcome,
} from './policy-isolation'
export { afterAll, describe, expect, test } from './runner'

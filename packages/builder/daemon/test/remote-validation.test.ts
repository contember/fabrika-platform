import {
	DEFAULT_APPROVAL_CATEGORIES,
	PERMISSIVE_SETTINGS,
	policyFromCategories,
	STRICT_POLICY,
	STRICT_SETTINGS,
	type SurfaceEndpointDto,
} from '@fabrika/control-contract'
import { expect, test } from 'bun:test'
import { parseEnvironments, parseRun, PlatformRemote } from '../src/platform-remote'
import { PlatformError } from '../src/platform-storage'

test('remote projections keep exact identities, finite recursive JSON and forward-compatible fields', () => {
	const health: SurfaceEndpointDto = {
		id: 'health',
		method: 'GET',
		path: '/healthz',
		kind: 'health',
		reach: 'anyone',
		callers: [],
		requirement: null,
		notes: [],
	}
	const envelope = { provider: 'zerops', version: 0, payload: { list: [null, true, 'x', 1.5] } }
	const environment = {
		appId: ' app ',
		env: 'dev',
		domain: null,
		publicOrigin: null,
		crossOrigins: ['https://partner.example.org'],
		triggerRef: '',
		kind: 'standard' as const,
		authoring: false,
		protected: false,
		approvalCategories: ['off-road' as const, 'grants' as const],
		approvalPolicy: { ...policyFromCategories(['off-road', 'grants']), secrets: 'off' as const },
		approvalSettings: PERMISSIVE_SETTINGS,
		publishedRunId: null,
		deviationSubjects: [{ subject: 'Endpoint `api.notes.summary`', steps: ['declares raw SQL (`read`)'] }],
		surface: [health],
		namespaceId: null,
		provider: 'zerops',
		target: envelope,
		artifact: envelope,
		createdAt: 0,
	}
	expect(() => parseEnvironments({ items: [environment] })).toThrow(PlatformError)
	expect(parseEnvironments({ items: [{ ...environment, triggerRef: null, ignored: true }], cursor: 'next' }))
		.toEqual([{ ...environment, triggerRef: null }])
	const {
		deviationSubjects: _,
		crossOrigins: __,
		surface: ___,
		kind: ____,
		approvalCategories: _____,
		approvalPolicy: ______,
		approvalSettings: _______,
		...fromOlderControl
	} = {
		...environment,
		triggerRef: null,
	}
	expect(parseEnvironments({ items: [fromOlderControl] })).toEqual([
		{
			...environment,
			triggerRef: null,
			deviationSubjects: [],
			crossOrigins: [],
			surface: [],
			approvalCategories: [...DEFAULT_APPROVAL_CATEGORIES],
			approvalPolicy: STRICT_POLICY,
			approvalSettings: STRICT_SETTINGS,
		},
	])
	expect(parseEnvironments({ items: [{ ...environment, triggerRef: null, approvalCategories: ['grants', 'from-a-newer-control'] }] })).toEqual([
		{ ...environment, triggerRef: null, approvalCategories: ['grants'] },
	])
	// A policy with a mode this release does not know stands for the categories beside it.
	const newerPolicy = { ...environment, triggerRef: null, approvalPolicy: { ...environment.approvalPolicy, secrets: 'from-a-newer-control' } }
	expect(parseEnvironments({ items: [newerPolicy] })).toEqual([{
		...environment,
		triggerRef: null,
		approvalPolicy: policyFromCategories(['off-road', 'grants']),
	}])
	// A Control older than requesterMayApprove keeps every other setting it sends.
	const { requesterMayApprove: ________, ...withoutRequester } = PERMISSIVE_SETTINGS
	expect(parseEnvironments({ items: [{ ...environment, triggerRef: null, approvalSettings: withoutRequester }] })).toEqual([{
		...environment,
		triggerRef: null,
		approvalSettings: { ...PERMISSIVE_SETTINGS, requesterMayApprove: STRICT_SETTINGS.requesterMayApprove },
	}])
	// A Control older than stepUp keeps every other setting it sends.
	const { stepUp: _________, ...withoutStepUp } = { ...PERMISSIVE_SETTINGS, requestTtlHours: 48 }
	expect(parseEnvironments({ items: [{ ...environment, triggerRef: null, approvalSettings: withoutStepUp }] })).toEqual([{
		...environment,
		triggerRef: null,
		approvalSettings: { ...PERMISSIVE_SETTINGS, requestTtlHours: 48, stepUp: STRICT_SETTINGS.stepUp },
	}])
	// A Control older than credentialCeiling keeps every other setting it sends.
	const { credentialCeiling: __________, ...withoutCeiling } = { ...PERMISSIVE_SETTINGS, requestTtlHours: 48 }
	expect(parseEnvironments({ items: [{ ...environment, triggerRef: null, approvalSettings: withoutCeiling }] })).toEqual([{
		...environment,
		triggerRef: null,
		approvalSettings: { ...PERMISSIVE_SETTINGS, requestTtlHours: 48, credentialCeiling: 'requester' },
	}])
	// A Control older than plans keeps every other setting it sends.
	const { planBinding: ____________, planTtlDays: _____________, ...withoutPlans } = { ...PERMISSIVE_SETTINGS, requestTtlHours: 48 }
	expect(parseEnvironments({ items: [{ ...environment, triggerRef: null, approvalSettings: withoutPlans }] })).toEqual([{
		...environment,
		triggerRef: null,
		approvalSettings: { ...PERMISSIVE_SETTINGS, requestTtlHours: 48, planBinding: 'transition', planTtlDays: 30 },
	}])
	// A Control older than a step-up category keeps every other setting it sends, and that category takes its default.
	const { 'agent-write': ___________, ...olderStepUp } = PERMISSIVE_SETTINGS.stepUp
	expect(parseEnvironments({ items: [{ ...environment, triggerRef: null, approvalSettings: { ...PERMISSIVE_SETTINGS, stepUp: olderStepUp } }] }))
		.toEqual([{
			...environment,
			triggerRef: null,
			approvalSettings: { ...PERMISSIVE_SETTINGS, stepUp: { ...PERMISSIVE_SETTINGS.stepUp, 'agent-write': STRICT_SETTINGS.stepUp['agent-write'] } },
		}])
	expect(() => parseEnvironments({ items: [{ ...environment, triggerRef: null, target: { ...envelope, payload: { secret: Infinity } } }] }))
		.toThrow('Invalid stored or upstream data')
	const run: ReturnType<typeof parseRun> = { id: 'run', appId: 'app', env: 'dev', ref: 'sha', commitSha: null, status: 'running' }
	expect(parseRun({ ...run, extra: 'ignored' })).toEqual(run)
	expect(() => parseRun({ ...run, status: 'cancelled' })).toThrow('Invalid deploy run status')
	expect(() => parseRun({ ...run, commitSha: undefined })).toThrow('Invalid stored or upstream data')
})

test('discovery keeps Builder-specific origin policy and explicit unsupported-provider diagnostics', async () => {
	const remote = (data: unknown) => new PlatformRemote(async () => Response.json(data), new AbortController().signal)
	const discovery = { version: 1, controlOrigin: 'http://localhost:1234/', iamIssuer: 'https://iam.example.test/', provider: 'zerops' }
	expect(await remote(discovery).discover('http://localhost:1234')).toEqual({
		controlOrigin: 'http://localhost:1234',
		iamIssuer: 'https://iam.example.test',
	})
	await expect(remote({ ...discovery, provider: 'future' }).discover('http://localhost:1234')).rejects.toThrow('Unsupported provider')
	await expect(remote({ ...discovery, controlOrigin: 'http://127.1:1234' }).discover('http://localhost:1234')).rejects.toThrow()
	await expect(remote({ ...discovery, secret: 'credential' }).discover('http://localhost:1234')).rejects.toThrow(
		'Unsupported builder discovery response',
	)
})

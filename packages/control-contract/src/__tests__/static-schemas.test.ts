import { expect, test } from 'bun:test'
import { parseBuilderApprovalState, parseBuilderInstallationDiscovery } from '../builder-bootstrap'
import { parseBuilderConnectionReceipt } from '../builder-connections'

const receipt = {
	version: 1,
	attemptId: '01980000-0000-7000-8000-000000000001',
	provider: 'zerops',
	app: {
		id: 'app',
		repoUrl: '',
		defaultBranch: '',
		workerDir: null,
		buildCmd: '',
		configPath: null,
		githubInstallationId: 0,
		createdAt: 0,
	},
	environment: { env: 'prod', namespaceId: null, domain: null, publicOrigin: null, triggerRef: null },
	createdAt: 0,
}

test('receipt preserves bytes, nulls, empty unbounded strings and optional omission', () => {
	expect(JSON.stringify(parseBuilderConnectionReceipt(receipt))).toBe(JSON.stringify(receipt))
	expect(
		Object.hasOwn(parseBuilderConnectionReceipt({ ...receipt, app: { ...receipt.app, githubConnectionId: undefined } }).app, 'githubConnectionId'),
	).toBe(false)
	expect(parseBuilderConnectionReceipt({ ...receipt, app: { ...receipt.app, githubConnectionId: null } }).app.githubConnectionId).toBeNull()
})

test('receipt keeps rejection categories and precedence without exposing unknown names', () => {
	const cases: [unknown, string][] = [
		[null, 'invalid builder connection receipt object'],
		[{ ...receipt, secret: true, version: 2 }, 'invalid builder connection receipt object'],
		[{ ...receipt, version: 2, app: null }, 'unsupported builder connection receipt version'],
		[{ ...receipt, attemptId: '', app: { ...receipt.app, secret: true } }, 'invalid builder connection receipt object'],
		[{ ...receipt, attemptId: '', app: { ...receipt.app, githubInstallationId: -1 } }, 'invalid githubInstallationId'],
		[{ ...receipt, attemptId: '' }, 'invalid receipt attemptId'],
		[{ ...receipt, provider: '' }, 'invalid receipt provider'],
		[{ ...receipt, app: { ...receipt.app, repoUrl: null } }, 'invalid receipt repoUrl'],
		[{ ...receipt, app: { ...receipt.app, createdAt: Number.MAX_SAFE_INTEGER + 1 } }, 'invalid receipt createdAt'],
		[{ ...receipt, environment: { ...receipt.environment, domain: '' } }, 'invalid receipt domain'],
		[{ ...receipt, environment: { ...receipt.environment, namespaceId: 'a'.repeat(129) } }, 'invalid receipt namespaceId'],
		[{ ...receipt, createdAt: 1.5 }, 'invalid receipt createdAt'],
	]
	for (const [value, message] of cases) expect(() => parseBuilderConnectionReceipt(value)).toThrow(message)
})

test('discovery normalizes origins and requires exactly its own four fields', () => {
	const discovery = { version: 1, controlOrigin: 'https://CONTROL.example:443/', iamIssuer: 'http://iam.localhost/', provider: 'zerops' }
	expect(parseBuilderInstallationDiscovery(discovery)).toEqual({
		version: 1,
		controlOrigin: 'https://control.example',
		iamIssuer: 'http://iam.localhost',
		provider: 'zerops',
	})
	for (const value of [null, [], { ...discovery, secret: true }, { ...discovery, provider: '' }, Object.create(discovery)]) {
		expect(parseBuilderInstallationDiscovery(value)).toBeNull()
	}
	for (const controlOrigin of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?x=1']) {
		expect(parseBuilderInstallationDiscovery({ ...discovery, controlOrigin })).toBeNull()
	}
})

test('approval parser remains independently embeddable', () => {
	const parse = new Function(`return (${parseBuilderApprovalState.toString()})`)()
	expect(parse({ attemptId: receipt.attemptId, approvalVerifier: 'a'.repeat(43), expiresAt: 600 }, 0)).toEqual({
		attemptId: receipt.attemptId,
		approvalVerifier: 'a'.repeat(43),
		expiresAt: 600,
	})
})

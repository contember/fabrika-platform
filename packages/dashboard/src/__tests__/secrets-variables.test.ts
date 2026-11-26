import { STRICT_POLICY, STRICT_SETTINGS } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { secretDeleteConsequence, SecretsSection, secretWhereabouts, secretWrite } from '../components/app-detail/SecretsSection'
import { varDeleteConsequence, VariablesSection } from '../components/app-detail/VariablesSection'
import type { AppEnvDto, AppSecretDto, AppVarDto } from '../lib/api'
import { cellAt, layersByName } from '../lib/config-layers'

const environment = (env: string): AppEnvDto => ({
	appId: 'notes',
	env,
	kind: 'standard',
	domain: null,
	publicOrigin: null,
	crossOrigins: [],
	triggerRef: 'refs/heads/main',
	authoring: false,
	protected: false,
	approvalCategories: [],
	approvalPolicy: STRICT_POLICY,
	approvalSettings: STRICT_SETTINGS,
	publishedRunId: null,
	deviationSubjects: [],
	surface: [],
	namespaceId: null,
	provider: 'cloudflare',
	target: { provider: 'cloudflare', version: 1, payload: {} },
	artifact: { provider: 'cloudflare', version: 1, payload: {} },
	createdAt: 0,
})

const envs = [environment('prod'), environment('test')]

const secret = (name: string, env: string | null, storage: AppSecretDto['storage'] = 'vault'): AppSecretDto => ({
	appId: 'notes',
	env,
	name,
	storage,
	valueRef: storage === 'vault' ? `vault:${name}-${env ?? 'all'}` : null,
	createdAt: 0,
})

const variable = (name: string, env: string | null, value: string): AppVarDto => ({ appId: 'notes', env, name, value, createdAt: 0 })

describe('configuration by layer', () => {
	test('entries group one row per name, in name order; an environment reads its own, else the one for all, else nothing', () => {
		const rows = layersByName([secret('B', 'prod'), secret('A', null), secret('A', 'test'), secret('B', null)])
		expect(rows.map((row) => row.name)).toEqual(['A', 'B'])
		const [a, b] = rows
		if (a === undefined || b === undefined) throw new Error('two rows expected')
		expect(cellAt(a, 'test').kind).toBe('own')
		expect(cellAt(a, 'prod').kind).toBe('inherits')
		expect(cellAt(b, 'prod').kind).toBe('own')
		expect(cellAt(layersByName([secret('C', 'prod')])[0] ?? b, 'test').kind).toBe('missing')
	})
})

describe('secrets as a matrix', () => {
	const render = (secrets: AppSecretDto[]) =>
		renderToStaticMarkup(createElement(SecretsSection, { appId: 'notes', secrets, envs, onDone: () => undefined }))

	test('one row per name, one column per layer, and a secret set on one environment only shows its gap', () => {
		const html = render([secret('PAYMENT_API_KEY', 'prod', 'provider'), secret('SESSION_SIGNING_KEY', null)])
		expect(html).toContain('<th class="layer-head">All environments</th><th class="layer-head">prod</th><th class="layer-head">test</th>')
		expect(html).toContain('aria-label="PAYMENT_API_KEY on prod: set"')
		expect(html).toContain('aria-label="PAYMENT_API_KEY on test: missing"')
		expect(html).toContain('aria-label="PAYMENT_API_KEY on all environments: not set"')
		expect(html).toContain('aria-label="SESSION_SIGNING_KEY on test: reads the value for all environments"')
		expect(html).toContain('aria-label="SESSION_SIGNING_KEY on all environments: set"')
	})

	test('no value and no vault reference reaches the page; a row stored outside the vault asks to be set again', () => {
		const html = render([secret('API_KEY', 'prod'), secret('OLD_KEY', 'prod', 'legacy')])
		expect(html).not.toContain('vault:API_KEY')
		expect(html).toContain('aria-label="OLD_KEY on prod: stored outside the vault, set it again"')
	})

	test('a layer says where its value is, or what the environment reads without it', () => {
		const [vault] = layersByName([secret('K', 'prod')])
		const [provider] = layersByName([secret('K', 'prod', 'provider')])
		const [legacy] = layersByName([secret('K', 'prod', 'legacy')])
		const [inherited] = layersByName([secret('K', null)])
		if (vault === undefined || provider === undefined || legacy === undefined || inherited === undefined) throw new Error('rows expected')
		expect(secretWhereabouts(vault, 'prod')).toBe("Set, sealed in Control's vault.")
		expect(secretWhereabouts(provider, 'prod')).toBe('Set, kept by the hosting of prod, not by Control.')
		expect(secretWhereabouts(legacy, 'prod')).toBe('Stored outside the vault, so a deploy cannot read it: set it again.')
		expect(secretWhereabouts(vault, 'test')).toBe('Not set on test or for all environments: a deploy of test has no value for it.')
		expect(secretWhereabouts(inherited, 'test')).toBe('Not set on test: it reads the value for all environments. A value here overrides it for test.')
	})

	test('a vault value is rotated in place; a layer kept by the provider, stored outside the vault or empty is set afresh', () => {
		const [row] = layersByName([secret('K', 'prod'), secret('K', 'test', 'provider'), secret('K', null, 'legacy')])
		if (row === undefined) throw new Error('a row expected')
		expect(secretWrite(row, 'prod')).toBe('rotate')
		expect(secretWrite(row, 'test')).toBe('set')
		expect(secretWrite(row, null)).toBe('set')
		const [missing] = layersByName([secret('K', 'prod')])
		if (missing === undefined) throw new Error('a row expected')
		expect(secretWrite(missing, 'test')).toBe('set')
	})

	test('deleting a layer says what the environments are left with', () => {
		const [both] = layersByName([secret('K', null), secret('K', 'prod')])
		if (both === undefined) throw new Error('a row expected')
		expect(secretDeleteConsequence(both, 'prod', envs)).toBe('prod then reads the value for all environments.')
		expect(secretDeleteConsequence(both, null, envs)).toBe('Then a deploy of test has no value for it.')
		const [onlyProd] = layersByName([secret('K', 'prod')])
		if (onlyProd === undefined) throw new Error('a row expected')
		expect(secretDeleteConsequence(onlyProd, 'prod', envs)).toBe('A deploy of prod then has no value for it.')
	})
})

describe('variables as a matrix', () => {
	test('each layer shows its value, an inherited one says so, and an unset one is a dash', () => {
		const html = renderToStaticMarkup(
			createElement(VariablesSection, {
				appId: 'notes',
				vars: [variable('LOG_LEVEL', null, 'info'), variable('LOG_LEVEL', 'prod', 'warn'), variable('FEATURE_LABELS', 'test', 'true')],
				envs,
				onDone: () => undefined,
			}),
		)
		expect(html).toContain('aria-label="LOG_LEVEL on prod: warn"')
		expect(html).toContain('aria-label="LOG_LEVEL on test: reads the value for all environments"')
		expect(html).toContain('aria-label="FEATURE_LABELS on prod: not set"')
		expect(html).toContain('<code class="layer-value" title="info">info</code>')
	})

	test('deleting a layer says what the environments are left with', () => {
		const [row] = layersByName([variable('LOG_LEVEL', null, 'info'), variable('LOG_LEVEL', 'prod', 'warn'), variable('LOG_LEVEL', 'test', 'debug')])
		if (row === undefined) throw new Error('a row expected')
		expect(varDeleteConsequence(row, 'test', envs)).toBe('test then reads the value for all environments.')
		expect(varDeleteConsequence(row, null, envs)).toBe('Every environment has its own value, so none loses it.')
	})
})

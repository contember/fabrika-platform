import { describe, expect, test } from 'bun:test'
import type { InstallationEmail } from '../email'
import {
	checkInstallationModel,
	type ModelService,
	type ModelVariable,
	PLATFORM_SERVICES,
	type PlatformInstallationModel,
	platformInstallationModel,
	staticEnvironment,
	variableKey,
} from '../model'
import { generateInstallationSecrets } from '../secrets'
import {
	deployedServiceEnvironment,
	INSTALLATION_SECRET_VARIABLES,
	installationServiceEnvironment,
	type InstallationServiceInput,
	type PlatformService,
} from '../service-environment'

const CONTROL = { migrate: 'packages/control/src/x/migrate.ts', server: 'packages/control/src/x/server.ts', job: 'packages/control/src/x/cron.ts' }
const model = platformInstallationModel({ control: CONTROL })

const storage = (name: string) => ({
	bucket: `${name}-bucket`,
	accessKeyId: `${name}-id`,
	secretAccessKey: `${name}-secret`,
	endpoint: `${name}-endpoint`,
})
const EMAIL: InstallationEmail = {
	kind: 'provider',
	variables: new Map([['FABRIKA_EMAIL_PROVIDER', 'smtp'], ['FABRIKA_EMAIL_FROM', 'ops@example.com'], ['FABRIKA_EMAIL_SMTP_PASSWORD', 'pw']]),
	secretNames: new Set(['FABRIKA_EMAIL_SMTP_PASSWORD']),
}

/** The bring-up's input with every condition on or off: OIDC, mail, OAuth. */
const installation = (on: boolean): InstallationServiceInput => ({
	environment: 'stage',
	scheme: 'https',
	hosts: { iam: 'iam.example.com', control: 'console.example.com', operations: 'errors.example.com' },
	iamUpstream: 'iam:3000',
	secrets: generateInstallationSecrets(),
	data: { iamDatabase: 'a', controlDatabase: 'b', operationsDatabase: 'c', runLogs: storage('runs'), operationsBlobs: storage('blobs') },
	email: on ? EMAIL : { kind: 'none' },
	authentication: on
		? { passwordEnabled: true, oidc: { issuer: 'https://idp.example.com', clientId: 'id', clientSecret: 'secret' } }
		: { passwordEnabled: true },
})
const deployed = (input: InstallationServiceInput, on: boolean) =>
	deployedServiceEnvironment({
		...input,
		provisioningKey: input.secrets.provisioningKey,
		controlTableDigest: 'digest',
		...(on ? { oauthConfig: { resources: [], hosts: [] }, operationsOAuthResource: 'https://errors.example.com/rpc' } : {}),
	})

const applies = (variable: ModelVariable, on: boolean): boolean => !('when' in variable) || variable.when === undefined || on
const named = (service: PlatformService, kinds: readonly ModelVariable['kind'][], on: boolean): string[] =>
	model.services[service].environment
		.filter((variable) => kinds.includes(variable.kind) && 'name' in variable && applies(variable, on))
		.map(variableKey)
		.sort()

/** The names a function wrote, without a bucket's coordinates (the provider spells those) or the mail family. */
const written = (service: PlatformService, env: ReadonlyMap<string, string>): string[] => {
	const prefixes = model.services[service].environment.flatMap((variable) => ('prefix' in variable ? [`${variable.prefix}_`] : []))
	return [...env.keys()].filter((key) => !prefixes.some((prefix) => key.startsWith(prefix)) && !EMAIL.variables.has(key)).sort()
}

describe('the installation model', () => {
	test('names every variable the bring-up and the deploy write, with every condition on or off', () => {
		for (const on of [true, false]) {
			const input = installation(on)
			const bringUp = installationServiceEnvironment(input)
			const deploy = deployed(input, on)
			for (const service of PLATFORM_SERVICES) {
				const both = new Map([...bringUp[service], ...deploy[service]])
				expect({ service, names: written(service, both) }).toEqual({
					service,
					names: named(service, ['data', 'generated', 'bring-up', 'derived'], on),
				})
			}
		}
	})

	test('a deploy writes exactly the derived variables, so a bring-up choice survives it', () => {
		for (const on of [true, false]) {
			const deploy = deployed(installation(on), on)
			for (const service of PLATFORM_SERVICES) {
				expect({ service, names: written(service, deploy[service]) }).toEqual({ service, names: named(service, ['derived'], on) })
			}
		}
	})

	test('a bucket prefix is the prefix of the coordinates the bring-up writes', () => {
		const env = installationServiceEnvironment(installation(false))
		expect([...env.control.keys()].filter((key) => key.startsWith('FABRIKA_CONTROL_RUN_LOGS_')).length).toBe(4)
		expect([...env.operations.keys()].filter((key) => key.startsWith('FABRIKA_OPERATIONS_BLOB_')).length).toBe(4)
	})

	test('a generated variable carries the secret it names, which every reader shares', () => {
		const input = installation(true)
		const env = installationServiceEnvironment(input)
		for (const service of PLATFORM_SERVICES) {
			const generatedNames: string[] = []
			for (const variable of model.services[service].environment) {
				if (variable.kind !== 'generated') continue
				generatedNames.push(variable.name)
				expect({ service, name: variable.name, value: env[service].get(variable.name) }).toEqual({
					service,
					name: variable.name,
					value: variable.secret === undefined ? undefined : input.secrets[variable.secret],
				})
			}
			expect(generatedNames.sort()).toEqual([...INSTALLATION_SECRET_VARIABLES[service]].sort())
		}
	})

	test('an upgrade may generate IAM data key alone', () => {
		expect(Object.entries(model.secrets).filter(([, secret]) => secret.upgrade === 'mint').map(([name]) => name)).toEqual(['dataKey'])
	})

	test('the proxy is the one public service, and the three hosts are routed to it', () => {
		expect(PLATFORM_SERVICES.filter((service) => model.services[service].public)).toEqual(['proxy'])
		expect(model.hosts).toEqual(['iam', 'control', 'operations'])
	})

	test('Control runs from the entry points its provider gives', () => {
		expect(model.services.control.entry).toEqual({ migrate: CONTROL.migrate, server: CONTROL.server })
		expect(model.services.control.jobs).toEqual([{ command: CONTROL.job, schedule: '*/5 * * * *' }])
	})

	test('the static environment spells each address at the host the renderer gives', () => {
		expect(staticEnvironment(model, 'operations')).toEqual([
			['PORT', '3000'],
			['FABRIKA_IAM_RPC_URL', 'http://iam:3000'],
			['FABRIKA_CONTROL_URL', 'http://control:3000'],
		])
		expect(staticEnvironment(model, 'iam', (service) => `${service}.internal`)).toEqual([
			['PORT', '3000'],
			['FABRIKA_CONTROL_URL', 'http://control.internal:3000'],
		])
		expect(staticEnvironment(model, 'proxy')).toEqual([])
	})
})

describe('checkInstallationModel refuses', () => {
	const withService = (name: PlatformService, change: (service: ModelService) => ModelService): PlatformInstallationModel => ({
		...model,
		services: { ...model.services, [name]: change(model.services[name]) },
	})

	test('a public service other than the proxy, and a proxy that is not public', () => {
		expect(() => checkInstallationModel(withService('control', (service) => ({ ...service, public: true })))).toThrow('the proxy alone is')
		expect(() => checkInstallationModel(withService('proxy', (service) => ({ ...service, public: false })))).toThrow('the proxy alone is')
	})

	test('an address to a service it does not call', () => {
		expect(() => checkInstallationModel(withService('iam', (service) => ({ ...service, calls: [] })))).toThrow('which it does not call')
	})

	test('a store read by a service that does not own it', () => {
		const reads: ModelVariable = { kind: 'data', name: 'FABRIKA_X_DATABASE_URL', database: 'iam' }
		expect(() => checkInstallationModel(withService('control', (service) => ({ ...service, environment: [...service.environment, reads] })))).toThrow(
			'which it does not own',
		)
	})

	test('a variable named twice, and a schedule of another form', () => {
		const twice: ModelVariable = { kind: 'fixed', name: 'PORT', value: '1' }
		expect(() => checkInstallationModel(withService('iam', (service) => ({ ...service, environment: [...service.environment, twice] })))).toThrow(
			'names PORT twice',
		)
		expect(() => checkInstallationModel(withService('iam', (service) => ({ ...service, jobs: [{ command: 'x', schedule: '@daily' }] })))).toThrow(
			'schedule of another form',
		)
	})
})

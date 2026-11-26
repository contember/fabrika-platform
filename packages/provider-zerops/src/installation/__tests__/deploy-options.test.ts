// The CLI surface a generated GitHub Actions workflow is written against.
//
// Its most load-bearing property is negative: there is NO flag that carries a credential, so an
// unknown flag has to be an error rather than something the parser ignores.

import { describe, expect, test } from 'bun:test'
import { parsePlatformDeployArgs as parseArgs } from '../deploy-options'

const parsePlatformDeployArgs: typeof parseArgs = (argv, env) => parseArgs(['--source-dir=.', ...argv], env)

const ENV = {
	FABRIKA_ZEROPS_ACCESS_TOKEN: 'zerops-token',
	FABRIKA_IAM_PROVISIONING_KEY: 'px_admin',
}

describe('credentials', () => {
	test('come from the environment', () => {
		const input = parsePlatformDeployArgs(['--project-id=p1', '--env=stage'], ENV)
		expect(input.accessToken).toBe('zerops-token')
		expect(input.iamAdminKey).toBe('px_admin')
	})

	test('have no flag, so putting one on the command line is an error and not a silent no-op', () => {
		expect(() => parsePlatformDeployArgs(['--project-id=p1', '--env=stage', '--token=abc'], ENV)).toThrow('unexpected argument')
		expect(() => parsePlatformDeployArgs(['--project-id=p1', '--env=stage', '--admin-key=abc'], ENV)).toThrow('unexpected argument')
	})

	test('a missing one names the variable that supplies it', () => {
		expect(() => parsePlatformDeployArgs(['--project-id=p1', '--env=stage'], {})).toThrow('FABRIKA_ZEROPS_ACCESS_TOKEN')
		expect(() => parsePlatformDeployArgs(['--project-id=p1', '--env=stage'], { FABRIKA_ZEROPS_ACCESS_TOKEN: 't' })).toThrow(
			'FABRIKA_IAM_PROVISIONING_KEY',
		)
	})

	test('a dry run needs the Zerops token but not the IAM admin key — it authenticates a write it never makes', () => {
		const input = parsePlatformDeployArgs(['--project-id=p1', '--env=stage', '--dry-run'], { FABRIKA_ZEROPS_ACCESS_TOKEN: 't' })
		expect(input.dryRun).toBe(true)
		expect(input.iamAdminKey).toBe('')
	})
})

describe('the project', () => {
	test('by id', () => {
		expect(parsePlatformDeployArgs(['--project-id=p1', '--env=stage'], ENV).project).toEqual({ kind: 'id', projectId: 'p1' })
	})

	test('by name, which needs the client it lives under', () => {
		expect(parsePlatformDeployArgs(['--project-name=fabrika-test', '--client-id=c1', '--env=stage'], ENV).project).toEqual({
			kind: 'name',
			clientId: 'c1',
			name: 'fabrika-test',
		})
		expect(() => parsePlatformDeployArgs(['--project-name=fabrika-test', '--env=stage'], ENV)).toThrow('--client-id')
	})

	test('never both', () => {
		expect(() => parsePlatformDeployArgs(['--project-id=p1', '--project-name=x', '--env=stage'], ENV)).toThrow('not both')
	})

	test('from the environment when no flag names one', () => {
		expect(parsePlatformDeployArgs(['--env=stage'], { ...ENV, FABRIKA_ZEROPS_PROJECT_ID: 'p9' }).project).toEqual({
			kind: 'id',
			projectId: 'p9',
		})
	})

	test('and a flag beats the environment', () => {
		expect(parsePlatformDeployArgs(['--project-id=p1', '--env=stage'], { ...ENV, FABRIKA_ZEROPS_PROJECT_ID: 'p9' }).project).toEqual({
			kind: 'id',
			projectId: 'p1',
		})
	})
})

describe('the hosts', () => {
	test('all three or none', () => {
		expect(parsePlatformDeployArgs(['--project-id=p1', '--env=stage'], ENV).hosts).toBeUndefined()
		expect(
			parsePlatformDeployArgs(['--project-id=p1', '--env=stage', '--iam-host=a.test', '--console-host=b.test', '--operations-host=c.test'], ENV)
				.hosts,
		).toEqual({ iam: 'a.test', control: 'b.test', operations: 'c.test' })
		expect(() => parsePlatformDeployArgs(['--project-id=p1', '--env=stage', '--iam-host=a.test'], ENV)).toThrow('or none')
	})

	test('are bare hostnames — a scheme or a port is refused, not stripped', () => {
		const partial = ['--project-id=p1', '--env=stage', '--console-host=b.test', '--operations-host=c.test']
		expect(() => parsePlatformDeployArgs([...partial, '--iam-host=https://a.test'], ENV)).toThrow('not a bare hostname')
		expect(() => parsePlatformDeployArgs([...partial, '--iam-host=a.test:8080'], ENV)).toThrow('not a bare hostname')
	})
})

describe('the rest', () => {
	test('the environment name is required, because nothing may default to `local`', () => {
		expect(() => parsePlatformDeployArgs(['--project-id=p1'], ENV)).toThrow('FABRIKA_PLATFORM_ENVIRONMENT')
	})

	test('the scheme defaults to https and refuses anything else', () => {
		expect(parsePlatformDeployArgs(['--project-id=p1', '--env=stage'], ENV).scheme).toBe('https')
		expect(parsePlatformDeployArgs(['--project-id=p1', '--env=stage', '--scheme=http'], ENV).scheme).toBe('http')
		expect(() => parsePlatformDeployArgs(['--project-id=p1', '--env=stage', '--scheme=ftp'], ENV)).toThrow('--scheme')
	})

	test('a repeated flag is an error rather than a last-one-wins guess', () => {
		expect(() => parsePlatformDeployArgs(['--project-id=p1', '--project-id=p2', '--env=stage'], ENV)).toThrow('more than once')
	})
})

describe('MCP authoring', () => {
	const BASE = ['--project-id=p1', '--env=stage']
	const CLIENTS = JSON.stringify([{ provider: 'chatgpt', clientId: 'https://chatgpt.com/oauth/client.json', redirectUris: [] }])

	test('the former client list is refused from the environment or a flag, before anything else is read', () => {
		expect(() => parsePlatformDeployArgs(BASE, { ...ENV, FABRIKA_PLATFORM_MCP_CLIENTS_JSON: CLIENTS })).toThrow(
			'FABRIKA_PLATFORM_MCP_CLIENTS_JSON is set, and this release no longer reads it',
		)
		expect(() => parsePlatformDeployArgs([...BASE, `--mcp-clients=${CLIENTS}`], ENV)).toThrow('--mcp-clients is set')
		// Refused even where the rest of the input would be refused too, so the operator learns about it first.
		expect(() => parsePlatformDeployArgs([], { FABRIKA_PLATFORM_MCP_CLIENTS_JSON: '[]' })).toThrow('FABRIKA_PLATFORM_MCP_CLIENTS_JSON is set')
	})

	test('a blank client list is unset, as a workflow passes an unset variable', () => {
		expect(parsePlatformDeployArgs(BASE, { ...ENV, FABRIKA_PLATFORM_MCP_CLIENTS_JSON: '' }).mcpAuthoring).toBeUndefined()
		expect(parsePlatformDeployArgs([...BASE, '--mcp-clients='], ENV).mcpAuthoring).toBeUndefined()
	})

	test('the switch comes from the environment or a flag, the flag first, and is absent when unset', () => {
		expect(parsePlatformDeployArgs(BASE, ENV).mcpAuthoring).toBeUndefined()
		expect(parsePlatformDeployArgs(BASE, { ...ENV, FABRIKA_PLATFORM_MCP_AUTHORING: 'on' }).mcpAuthoring).toBe(true)
		expect(parsePlatformDeployArgs(BASE, { ...ENV, FABRIKA_PLATFORM_MCP_AUTHORING: 'off' }).mcpAuthoring).toBe(false)
		expect(parsePlatformDeployArgs([...BASE, '--mcp-authoring=off'], { ...ENV, FABRIKA_PLATFORM_MCP_AUTHORING: 'on' }).mcpAuthoring).toBe(false)
		expect(parsePlatformDeployArgs(BASE, { ...ENV, FABRIKA_PLATFORM_MCP_AUTHORING: ' ' }).mcpAuthoring).toBeUndefined()
	})

	test('refuses a switch that is neither on nor off, naming where it came from', () => {
		expect(() => parsePlatformDeployArgs(BASE, { ...ENV, FABRIKA_PLATFORM_MCP_AUTHORING: 'true' })).toThrow(
			'FABRIKA_PLATFORM_MCP_AUTHORING must be on or off',
		)
		expect(() => parsePlatformDeployArgs([...BASE, '--mcp-authoring=yes'], ENV)).toThrow('--mcp-authoring must be on or off')
	})

	test('refuses the switch on over plain http', () => {
		expect(() => parsePlatformDeployArgs([...BASE, '--scheme=http', '--mcp-authoring=on'], ENV)).toThrow('MCP authoring needs --scheme=https')
		expect(parsePlatformDeployArgs([...BASE, '--scheme=http', '--mcp-authoring=off'], ENV).mcpAuthoring).toBe(false)
	})

	test('hosts are lowercased, so every origin built from them is the one `URL` writes', () => {
		const hosts = ['--iam-host=IAM.Example.com', '--console-host=Console.Example.com', '--operations-host=Errors.Example.com']
		expect(parsePlatformDeployArgs([...BASE, ...hosts], ENV).hosts).toEqual({
			iam: 'iam.example.com',
			control: 'console.example.com',
			operations: 'errors.example.com',
		})
	})
})

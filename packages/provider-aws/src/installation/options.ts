// What `fabrika platform install --provider=aws` and `upgrade` take: the installation's account and region, its two
// networks' ranges, its hosts and their certificates, the release it runs, and, for an install alone, how people sign
// in and the outbound mail. Each from its flag or the variable beside it; a credential (the OIDC client's secret, a
// mailer's key, the operator's AWS keys) from the environment only. Errors name flags and variables, never a value.

import { builtinEmailProviders } from '@fabrika/email/providers'
import {
	type AuthMethods,
	checkedOidcIssuer,
	describeArgument,
	EMAIL_FLAGS,
	type InstallationAuthentication,
	type InstallationEmail,
	MCP_AUTHORING_VARIABLE,
	OIDC_CLIENT_ID_FLAG,
	OIDC_CLIENT_ID_INPUT,
	OIDC_CLIENT_SECRET_INPUT,
	OIDC_ISSUER_FLAG,
	OIDC_ISSUER_INPUT,
	parseMcpAuthoring,
	readAuthMethods,
	readEnv,
	readInstallationEmail,
	refuseFlags,
	requiredSetting,
	setting,
	UNATTENDED_FLAG,
} from '@fabrika/installation-init'
import type { AwsPlatformPlan } from './apply'
import { AWS_DEFAULT_PLATFORM_VPC_CIDR, AWS_DEFAULT_VPC_CIDR } from './network'

type Env = Readonly<Record<string, string | undefined>>

/** The public repository whose releases an installation runs, unless the operator names a fork. */
export const AWS_PLATFORM_REPOSITORY = 'contember/fabrika-platform'

/** Every flag the two commands take, with the variable each may come from instead. */
const FLAGS = {
	accountId: ['--account-id', 'FABRIKA_AWS_ACCOUNT_ID'],
	region: ['--region', 'FABRIKA_AWS_REGION'],
	appsVpcCidr: ['--apps-vpc-cidr', 'FABRIKA_AWS_APPS_VPC_CIDR'],
	platformVpcCidr: ['--platform-vpc-cidr', 'FABRIKA_AWS_PLATFORM_VPC_CIDR'],
	iamHost: ['--iam-host', 'FABRIKA_PLATFORM_IAM_HOST'],
	controlHost: ['--control-host', 'FABRIKA_PLATFORM_CONTROL_HOST'],
	operationsHost: ['--operations-host', 'FABRIKA_PLATFORM_OPERATIONS_HOST'],
	iamCertificate: ['--iam-certificate', 'FABRIKA_AWS_IAM_CERTIFICATE'],
	controlCertificate: ['--control-certificate', 'FABRIKA_AWS_CONTROL_CERTIFICATE'],
	operationsCertificate: ['--operations-certificate', 'FABRIKA_AWS_OPERATIONS_CERTIFICATE'],
	appsHost: ['--apps-host', 'FABRIKA_AWS_APPS_HOST'],
	appsCertificate: ['--apps-certificate', 'FABRIKA_AWS_APPS_CERTIFICATE'],
	environment: ['--environment', 'FABRIKA_PLATFORM_ENVIRONMENT'],
	repository: ['--repository', 'FABRIKA_PLATFORM_REPOSITORY'],
	commit: ['--commit', 'FABRIKA_PLATFORM_COMMIT'],
	baseImage: ['--base-image', 'FABRIKA_AWS_BASE_IMAGE'],
	mcpAuthoring: ['--mcp-authoring', MCP_AUTHORING_VARIABLE],
} satisfies Record<string, readonly [string, string]>
/** The flags an install takes beyond the two commands' own: how people sign in, and the mail. */
const INSTALL_FLAGS = ['--auth-methods', OIDC_ISSUER_FLAG, OIDC_CLIENT_ID_FLAG, ...EMAIL_FLAGS]

/** A release's full commit, a Bun image by digest, an environment's name. */
const COMMIT = /^[0-9a-f]{40}$/
const IMAGE_BY_DIGEST = /^[a-z0-9.-]{1,255}(?::\d{1,5})?\/[a-z0-9._/-]{1,256}@sha256:[0-9a-f]{64}$/
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** What both commands take. */
export interface AwsPlatformOptions {
	readonly plan: AwsPlatformPlan
	readonly environment: string
	readonly release: { readonly repository: string; readonly commitSha: string }
	readonly baseImage: string
	readonly mcpAuthoring: boolean
	/** Every confirmation answered yes, the question still printed: `--yes`. */
	readonly unattended: boolean
}

/** What an install takes beyond them. */
export interface AwsInstallOptions extends AwsPlatformOptions {
	readonly bringUp: { readonly authentication: InstallationAuthentication; readonly email: InstallationEmail }
}

const value = (argv: readonly string[], env: Env, key: keyof typeof FLAGS): string | undefined => {
	const [flag, variable] = FLAGS[key]
	return setting(argv, env, flag, variable)
}
const required = (argv: readonly string[], env: Env, key: keyof typeof FLAGS): string => {
	const [flag, variable] = FLAGS[key]
	return requiredSetting(value(argv, env, key), flag, variable)
}
const checked = (raw: string, form: RegExp, key: keyof typeof FLAGS, what: string): string => {
	if (!form.test(raw)) throw new Error(`${FLAGS[key][0]} is not ${what}`)
	return raw
}

/** Refuses an argument neither command takes, naming it and never its value. */
function assertKnownArguments(argv: readonly string[], extra: readonly string[]): void {
	const known = new Set([...Object.values(FLAGS).map(([flag]) => flag), ...extra, UNATTENDED_FLAG])
	const unknown = argv.find((arg) => !known.has(arg.split('=')[0] ?? ''))
	if (unknown !== undefined) throw new Error(`${describeArgument(unknown)} is not an argument of this command`)
}

function readOptions(argv: readonly string[], env: Env, extra: readonly string[]): AwsPlatformOptions {
	assertKnownArguments(argv, extra)
	const host = (key: 'iamHost' | 'controlHost' | 'operationsHost' | 'appsHost') => required(argv, env, key).toLowerCase()
	return {
		plan: {
			accountId: required(argv, env, 'accountId'),
			region: required(argv, env, 'region'),
			vpcCidrs: {
				apps: value(argv, env, 'appsVpcCidr') ?? AWS_DEFAULT_VPC_CIDR,
				platform: value(argv, env, 'platformVpcCidr') ?? AWS_DEFAULT_PLATFORM_VPC_CIDR,
			},
			hosts: { iam: host('iamHost'), control: host('controlHost'), operations: host('operationsHost') },
			certificates: {
				iam: required(argv, env, 'iamCertificate'),
				control: required(argv, env, 'controlCertificate'),
				operations: required(argv, env, 'operationsCertificate'),
			},
			appsDefault: { host: host('appsHost'), certificate: required(argv, env, 'appsCertificate') },
		},
		environment: checked(required(argv, env, 'environment'), ENVIRONMENT, 'environment', 'an environment name (a-z, 0-9, -)'),
		release: {
			repository: checked(value(argv, env, 'repository') ?? AWS_PLATFORM_REPOSITORY, REPOSITORY, 'repository', 'owner/name'),
			commitSha: checked(required(argv, env, 'commit'), COMMIT, 'commit', "the release's full commit id"),
		},
		baseImage: checked(required(argv, env, 'baseImage'), IMAGE_BY_DIGEST, 'baseImage', 'an image by digest (<registry>/<name>@sha256:<64 hex>)'),
		mcpAuthoring: parseMcpAuthoring(value(argv, env, 'mcpAuthoring'), FLAGS.mcpAuthoring[0]) ?? false,
		unattended: argv.includes(UNATTENDED_FLAG),
	}
}

/** What an install names when it names no method: password sign-in alone. */
const PASSWORD_ONLY: AuthMethods = { oidcEnabled: false, passwordEnabled: true }

/** The sign-in methods and, with OIDC, its client; the client's secret from the environment alone. */
function readAuthentication(argv: readonly string[], env: Env): InstallationAuthentication {
	const methods = readAuthMethods(argv, env, PASSWORD_ONLY)
	if (!methods.oidcEnabled) {
		refuseFlags(argv, [OIDC_ISSUER_FLAG, OIDC_CLIENT_ID_FLAG], 'OIDC is not among the IAM authentication methods')
		return { passwordEnabled: methods.passwordEnabled }
	}
	const oidc = {
		issuer: checkedOidcIssuer(requiredSetting(setting(argv, env, OIDC_ISSUER_FLAG, OIDC_ISSUER_INPUT), OIDC_ISSUER_FLAG, OIDC_ISSUER_INPUT)),
		clientId: requiredSetting(setting(argv, env, OIDC_CLIENT_ID_FLAG, OIDC_CLIENT_ID_INPUT), OIDC_CLIENT_ID_FLAG, OIDC_CLIENT_ID_INPUT),
		clientSecret: requiredSetting(readEnv(env, OIDC_CLIENT_SECRET_INPUT), '(no flag)', OIDC_CLIENT_SECRET_INPUT),
	}
	return methods.passwordEnabled ? { passwordEnabled: true, oidc } : { passwordEnabled: false, oidc }
}

/** `install`'s arguments and environment. */
export function parseAwsInstallArgs(argv: readonly string[], env: Env): AwsInstallOptions {
	return {
		...readOptions(argv, env, INSTALL_FLAGS),
		bringUp: {
			authentication: readAuthentication(argv, env),
			email: readInstallationEmail(argv, env, { registry: builtinEmailProviders, required: false }),
		},
	}
}

/** `upgrade`'s: an upgrade names no sign-in method and no mailer, which stay as the install or an operator set them. */
export function parseAwsUpgradeArgs(argv: readonly string[], env: Env): AwsPlatformOptions {
	return readOptions(argv, env, [])
}

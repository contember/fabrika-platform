// What `fabrika platform install --provider=aws` and `upgrade` take. Each value comes from its flag or the variable
// beside it; a credential (the OIDC client's secret, a mailer's key, the operator's AWS keys) from the environment
// only. Errors name flags and variables, never a value.
//
// - **Both** name the account and the region (checked here, before any call) and the release: its commit, its
//   repository, the applications' base image.
// - **An install** names every choice of the installation (`record.ts`): its two networks' ranges, its hosts and their
//   certificates, its environment's name, MCP authoring; and how people sign in and the outbound mail.
// - **An upgrade** names only what it changes: every choice it leaves out is the installation's own, read from its
//   record. It takes no sign-in method and no mailer, which stay as the install or an operator set them.

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
import { AWS_DEFAULT_PLATFORM_VPC_CIDR, AWS_DEFAULT_VPC_CIDR } from './network'
import type { AwsInstallationChoices } from './record'
import { AWS_ACCOUNT_ID_FORM, AWS_REGION_FORM } from './runtime'

type Env = Readonly<Record<string, string | undefined>>

/** The public repository whose releases an installation runs, unless the operator names a fork. */
export const AWS_PLATFORM_REPOSITORY = 'contember/fabrika-platform'

/** The flags both commands take, with the variable each may come from instead. */
const COMMON_FLAGS = {
	accountId: ['--account-id', 'FABRIKA_AWS_ACCOUNT_ID'],
	region: ['--region', 'FABRIKA_AWS_REGION'],
	repository: ['--repository', 'FABRIKA_PLATFORM_REPOSITORY'],
	commit: ['--commit', 'FABRIKA_PLATFORM_COMMIT'],
	baseImage: ['--base-image', 'FABRIKA_AWS_BASE_IMAGE'],
} satisfies Record<string, readonly [string, string]>
/** The installation's choices: every one an install names, the ones an upgrade changes. */
const CHOICE_FLAGS = {
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
	mcpAuthoring: ['--mcp-authoring', MCP_AUTHORING_VARIABLE],
} satisfies Record<string, readonly [string, string]>
type CommonKey = keyof typeof COMMON_FLAGS
type ChoiceKey = keyof typeof CHOICE_FLAGS
/** Every choice, in the order the usage names them. */
export const AWS_CHOICE_KEYS: readonly ChoiceKey[] = Object.keys(CHOICE_FLAGS).filter((name): name is ChoiceKey => name in CHOICE_FLAGS)
/** The flag a choice is named by. */
export const awsChoiceFlag = (key: ChoiceKey): string => CHOICE_FLAGS[key][0]
/** The flags an install takes beyond the choices: how people sign in, and the mail. */
const INSTALL_FLAGS = ['--auth-methods', OIDC_ISSUER_FLAG, OIDC_CLIENT_ID_FLAG, ...EMAIL_FLAGS]

/** A release's full commit, a Bun image by digest, an environment's name, a repository. */
const COMMIT = /^[0-9a-f]{40}$/
const IMAGE_BY_DIGEST = /^[a-z0-9.-]{1,255}(?::\d{1,5})?\/[a-z0-9._/-]{1,256}@sha256:[0-9a-f]{64}$/
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** What both commands take. */
export interface AwsCommonOptions {
	readonly accountId: string
	readonly region: string
	readonly release: { readonly repository: string; readonly commitSha: string }
	readonly baseImage: string
	/** Every confirmation answered yes, the question still printed: `--yes`. */
	readonly unattended: boolean
}

/** An install: every choice, and how people sign in and the mail. */
export interface AwsInstallOptions extends AwsCommonOptions {
	readonly choices: AwsInstallationChoices
	readonly bringUp: { readonly authentication: InstallationAuthentication; readonly email: InstallationEmail }
}

/** An upgrade: the choices it names, every other one the installation's own. */
export interface AwsUpgradeOptions extends AwsCommonOptions {
	readonly named: Readonly<Partial<Record<ChoiceKey, string>>>
}

const read = (argv: readonly string[], env: Env, [flag, variable]: readonly [string, string]): string | undefined =>
	setting(argv, env, flag, variable)
const required = (argv: readonly string[], env: Env, pair: readonly [string, string]): string =>
	requiredSetting(read(argv, env, pair), pair[0], pair[1])
const checked = (raw: string, form: RegExp, flag: string, what: string): string => {
	if (!form.test(raw)) throw new Error(`${flag} is not ${what}`)
	return raw
}

/** Refuses an argument the command does not take, naming it and never its value. */
function assertKnownArguments(argv: readonly string[], flags: readonly string[]): void {
	const known = new Set([...flags, UNATTENDED_FLAG])
	const unknown = argv.find((arg) => !known.has(arg.split('=')[0] ?? ''))
	if (unknown !== undefined) throw new Error(`${describeArgument(unknown)} is not an argument of this command`)
}

function readCommon(argv: readonly string[], env: Env): AwsCommonOptions {
	const flag = (key: CommonKey) => COMMON_FLAGS[key]
	return {
		accountId: checked(required(argv, env, flag('accountId')), AWS_ACCOUNT_ID_FORM, '--account-id', 'an account id (12 digits)'),
		region: checked(required(argv, env, flag('region')), AWS_REGION_FORM, '--region', 'a region name (eu-central-1)'),
		release: {
			repository: checked(read(argv, env, flag('repository')) ?? AWS_PLATFORM_REPOSITORY, REPOSITORY, '--repository', 'owner/name'),
			commitSha: checked(required(argv, env, flag('commit')), COMMIT, '--commit', "the release's full commit id"),
		},
		baseImage: checked(
			required(argv, env, flag('baseImage')),
			IMAGE_BY_DIGEST,
			'--base-image',
			'an image by digest (<registry>/<name>@sha256:<64 hex>)',
		),
		unattended: argv.includes(UNATTENDED_FLAG),
	}
}

/** The choices the operator names, each checked as the run takes it: hosts lower-case, MCP `on` or `off`. */
function readNamedChoices(argv: readonly string[], env: Env): Partial<Record<ChoiceKey, string>> {
	const named: Partial<Record<ChoiceKey, string>> = {}
	for (const key of AWS_CHOICE_KEYS) {
		const [flag] = CHOICE_FLAGS[key]
		let value = read(argv, env, CHOICE_FLAGS[key])
		if (value === undefined) continue
		if (key.endsWith('Host')) value = value.toLowerCase()
		if (key === 'environment') checked(value, ENVIRONMENT, flag, 'an environment name (a-z, 0-9, -)')
		if (key === 'mcpAuthoring') parseMcpAuthoring(value, flag)
		named[key] = value
	}
	return named
}

/** The installation's choices: the operator's named ones over `base`, every one required where `base` has none. */
export function awsChoicesFrom(
	common: Pick<AwsCommonOptions, 'accountId' | 'region'>,
	named: Readonly<Partial<Record<ChoiceKey, string>>>,
	base?: AwsInstallationChoices,
): AwsInstallationChoices {
	const pick = (key: ChoiceKey, held: string | undefined, fallback?: string): string => {
		const value = named[key] ?? held ?? fallback
		if (value === undefined) throw new Error(`${CHOICE_FLAGS[key][0]}=<value> or ${CHOICE_FLAGS[key][1]} is required`)
		return value
	}
	const held = base?.plan
	return {
		plan: {
			accountId: common.accountId,
			region: common.region,
			vpcCidrs: {
				apps: pick('appsVpcCidr', held?.vpcCidrs.apps, AWS_DEFAULT_VPC_CIDR),
				platform: pick('platformVpcCidr', held?.vpcCidrs.platform, AWS_DEFAULT_PLATFORM_VPC_CIDR),
			},
			hosts: {
				iam: pick('iamHost', held?.hosts.iam),
				control: pick('controlHost', held?.hosts.control),
				operations: pick('operationsHost', held?.hosts.operations),
			},
			certificates: {
				iam: pick('iamCertificate', held?.certificates.iam),
				control: pick('controlCertificate', held?.certificates.control),
				operations: pick('operationsCertificate', held?.certificates.operations),
			},
			appsDefault: { host: pick('appsHost', held?.appsDefault.host), certificate: pick('appsCertificate', held?.appsDefault.certificate) },
		},
		environment: pick('environment', base?.environment),
		mcpAuthoring: parseMcpAuthoring(named.mcpAuthoring, CHOICE_FLAGS.mcpAuthoring[0]) ?? base?.mcpAuthoring ?? false,
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
	const clientSecret = readEnv(env, OIDC_CLIENT_SECRET_INPUT)
	if (clientSecret === undefined) throw new Error(`${OIDC_CLIENT_SECRET_INPUT} is required in the environment (it has no flag)`)
	const oidc = {
		issuer: checkedOidcIssuer(requiredSetting(setting(argv, env, OIDC_ISSUER_FLAG, OIDC_ISSUER_INPUT), OIDC_ISSUER_FLAG, OIDC_ISSUER_INPUT)),
		clientId: requiredSetting(setting(argv, env, OIDC_CLIENT_ID_FLAG, OIDC_CLIENT_ID_INPUT), OIDC_CLIENT_ID_FLAG, OIDC_CLIENT_ID_INPUT),
		clientSecret,
	}
	return methods.passwordEnabled ? { passwordEnabled: true, oidc } : { passwordEnabled: false, oidc }
}

const flagNames = (flags: Readonly<Record<string, readonly [string, string]>>) => Object.values(flags).map(([flag]) => flag)

/** `install`'s arguments and environment: every choice named, a range unnamed taking its default. */
export function parseAwsInstallArgs(argv: readonly string[], env: Env): AwsInstallOptions {
	assertKnownArguments(argv, [...flagNames(COMMON_FLAGS), ...flagNames(CHOICE_FLAGS), ...INSTALL_FLAGS])
	const common = readCommon(argv, env)
	return {
		...common,
		choices: awsChoicesFrom(common, readNamedChoices(argv, env)),
		bringUp: {
			authentication: readAuthentication(argv, env),
			email: readInstallationEmail(argv, env, { registry: builtinEmailProviders, required: false }),
		},
	}
}

/** `upgrade`'s: the choices it names alone; the run takes every other from the installation's record. */
export function parseAwsUpgradeArgs(argv: readonly string[], env: Env): AwsUpgradeOptions {
	assertKnownArguments(argv, [...flagNames(COMMON_FLAGS), ...flagNames(CHOICE_FLAGS)])
	return { ...readCommon(argv, env), named: readNamedChoices(argv, env) }
}

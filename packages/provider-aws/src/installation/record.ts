// The installation's record: the choices an install made (its two networks' ranges, its hosts and their certificates,
// its environment's name, whether MCP authoring is on), kept in Parameter Store so an upgrade takes them from the
// installation itself rather than from the operator again.
//
// - **Written by the run, read before it.** An install writes it before its first stack, so a run that stopped part
//   way is resumed against the choices it started with. An upgrade reads it, takes every choice the operator does not
//   name from it, and compares the ones the operator names.
// - **What may change, and what may not.** A network's range is refused: CloudFormation replaces a VPC whose range
//   changes, and everything in it after. A host or the environment's name is refused too: either rewrites what the
//   services derive and the balancers route, which an upgrade does not do by the way. A certificate and MCP authoring
//   may change on purpose, and the run names each change before it asks.
// - **Not a secret, and no task's.** It sits under `/fabrika/platform/installation/`, which no task's execution role
//   and no grant of Control's names.

import { z } from 'zod'
import type { AwsPlatformPlan } from './apply'

/** Where the record lives, read and written with the operator's credentials alone. */
export const AWS_INSTALLATION_RECORD = '/fabrika/platform/installation/record'

/** The choices an install makes and an upgrade keeps. */
export interface AwsInstallationChoices {
	readonly plan: AwsPlatformPlan
	readonly environment: string
	readonly mcpAuthoring: boolean
}

const record = z.object({
	version: z.literal(1),
	plan: z.object({
		accountId: z.string(),
		region: z.string(),
		vpcCidrs: z.object({ apps: z.string(), platform: z.string() }),
		hosts: z.object({ iam: z.string(), control: z.string(), operations: z.string() }),
		certificates: z.object({ iam: z.string(), control: z.string(), operations: z.string() }),
		appsDefault: z.object({ host: z.string(), certificate: z.string() }),
	}),
	environment: z.string(),
	mcpAuthoring: z.boolean(),
})

/** The record's text, as the run writes it. */
export function encodeAwsInstallationRecord(choices: AwsInstallationChoices): string {
	return JSON.stringify({ version: 1, plan: choices.plan, environment: choices.environment, mcpAuthoring: choices.mcpAuthoring })
}

/** The record's choices, or an error naming the parameter when its text is of another form. */
export function parseAwsInstallationRecord(text: string): AwsInstallationChoices {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		parsed = null
	}
	const read = record.safeParse(parsed)
	if (!read.success) throw new Error(`aws: ${AWS_INSTALLATION_RECORD} is not an installation record this release reads`)
	const { plan, environment, mcpAuthoring } = read.data
	return { plan, environment, mcpAuthoring }
}

/** One choice as the operator names it, and how a difference from the record is taken. */
interface ChoiceField {
	readonly name: string
	readonly of: (choices: AwsInstallationChoices) => string
	/** `refused`: a difference stops the run; `named`: the run names it and goes on. */
	readonly change: 'refused' | 'named'
}

const FIELDS: readonly ChoiceField[] = [
	{ name: 'the applications network range', of: (c) => c.plan.vpcCidrs.apps, change: 'refused' },
	{ name: 'the platform network range', of: (c) => c.plan.vpcCidrs.platform, change: 'refused' },
	{ name: "IAM's host", of: (c) => c.plan.hosts.iam, change: 'refused' },
	{ name: "Control's host", of: (c) => c.plan.hosts.control, change: 'refused' },
	{ name: "Operations' host", of: (c) => c.plan.hosts.operations, change: 'refused' },
	{ name: "the applications' default host", of: (c) => c.plan.appsDefault.host, change: 'refused' },
	{ name: 'the environment name', of: (c) => c.environment, change: 'refused' },
	{ name: "IAM's certificate", of: (c) => c.plan.certificates.iam, change: 'named' },
	{ name: "Control's certificate", of: (c) => c.plan.certificates.control, change: 'named' },
	{ name: "Operations' certificate", of: (c) => c.plan.certificates.operations, change: 'named' },
	{ name: "the applications' default certificate", of: (c) => c.plan.appsDefault.certificate, change: 'named' },
	{ name: 'MCP authoring', of: (c) => (c.mcpAuthoring ? 'on' : 'off'), change: 'named' },
]

/**
 * How `wanted` differs from what the installation `held`: the changes a run refuses, and the ones it names and makes.
 * Each says what changes from what to what; none of these values is a secret.
 */
export function awsChoiceChanges(
	held: AwsInstallationChoices,
	wanted: AwsInstallationChoices,
): { readonly refused: readonly string[]; readonly named: readonly string[] } {
	const refused: string[] = []
	const named: string[] = []
	for (const field of FIELDS) {
		const from = field.of(held)
		const to = field.of(wanted)
		if (from === to) continue
		const change = `${field.name} from ${from} to ${to}`
		if (field.change === 'refused') refused.push(change)
		else named.push(change)
	}
	return { refused, named }
}

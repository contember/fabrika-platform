import type { AppGates, CredentialLocation, GateRule } from '@fabrika/auth-core'
import { z } from 'zod'

export const FABRIKA_PROXY_MANIFEST_JSON = 'FABRIKA_PROXY_MANIFEST_JSON'

export interface ProxyApp {
	/** The IAM app id, used as the minted token audience. */
	id: string
	/** Literal hostnames, lower-cased on parse; never patterns or host:port pairs. */
	hosts: string[]
	/** Private upstream dial address, for example `app:3000`. */
	upstream: string
	/** Ordered rules; evaluated only by auth-core in the proxy. */
	gates: AppGates
	/** Browser-facing scheme used for login and handoff URLs, defaulting to https. */
	scheme: 'http' | 'https'
}

export interface ProxyManifest {
	apps: ProxyApp[]
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Literal LDH hostnames only: Caddy reads wildcard labels and placeholders as routing patterns. */
export function isProxyHost(host: string): boolean {
	return host.length > 0 && host.length <= 253 && host.split('.').every((label) => label.length <= 63 && HOST_LABEL.test(label))
}

export const proxyCredentialLocationSchema = z.object({
	in: z.enum(['header', 'query', 'cookie']),
	name: z.string().min(1),
}) satisfies z.ZodType<CredentialLocation, z.ZodTypeDef, unknown>

const gatePathSchema = z.string().startsWith('/')
/** A gate rule's fields before normalization; a producer adds its own refinements on top. */
export const proxyGateRuleFieldsSchema = z.discriminatedUnion('kind', [
	z.object({ path: gatePathSchema, kind: z.literal('public') }),
	z.object({ path: gatePathSchema, kind: z.literal('human') }),
	z.object({ path: gatePathSchema, kind: z.literal('service'), credential: proxyCredentialLocationSchema.nullish() }),
])

/** Drop an absent service credential, so a rule without one carries no `credential` key at all. */
export const normalizeGateRule = (rule: z.infer<typeof proxyGateRuleFieldsSchema>): GateRule => {
	if (rule.kind !== 'service') return rule
	return { path: rule.path, kind: rule.kind, ...(rule.credential == null ? {} : { credential: rule.credential }) }
}

export const proxyGateRuleSchema = proxyGateRuleFieldsSchema.transform(normalizeGateRule) satisfies z.ZodType<GateRule, z.ZodTypeDef, unknown>

export const proxyAppGatesSchema = z.object({
	rules: z.array(proxyGateRuleSchema),
}) satisfies z.ZodType<AppGates, z.ZodTypeDef, unknown>

export const proxyAppSchema = z.object({
	id: z.string().min(1),
	hosts: z.array(z.string().toLowerCase().refine(isProxyHost)).min(1),
	upstream: z.string().min(1),
	gates: proxyAppGatesSchema,
	scheme: z.preprocess((value) => typeof value === 'string' ? value : undefined, z.enum(['http', 'https']).default('https')),
}) satisfies z.ZodType<ProxyApp, z.ZodTypeDef, unknown>

/** The first host two apps (or one app twice) claim, or null. A host belongs to exactly one app. */
export function findDuplicateProxyHost(apps: readonly Pick<ProxyApp, 'hosts'>[]): string | null {
	const hosts = new Set<string>()
	for (const host of apps.flatMap((app) => app.hosts)) {
		if (hosts.has(host)) return host
		hosts.add(host)
	}
	return null
}

export const proxyManifestSchema = z.object({
	apps: z.array(proxyAppSchema),
}).superRefine(({ apps }, ctx) => {
	if (new Set(apps.map((app) => app.id)).size !== apps.length) ctx.addIssue({ code: 'custom', message: 'duplicate proxy app id' })
	if (findDuplicateProxyHost(apps) !== null) ctx.addIssue({ code: 'custom', message: 'duplicate proxy host' })
}) satisfies z.ZodType<ProxyManifest, z.ZodTypeDef, unknown>

export function parseProxyManifest(value: unknown): ProxyManifest | null {
	const result = proxyManifestSchema.safeParse(value)
	return result.success ? result.data : null
}

export function parseProxyManifestJson(value: string): ProxyManifest | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}
	return parseProxyManifest(parsed)
}

export function encodeProxyManifestJson(manifest: ProxyManifest): string {
	return JSON.stringify(manifest)
}

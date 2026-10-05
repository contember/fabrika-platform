import type { AppGates, CredentialLocation, GateRule } from '@fabrika/auth-core'
import { z } from 'zod'
import { prop } from './json'

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

// Project own fields before parsing: inherited routing fields have never been part of this wire contract.
export const proxyCredentialLocationSchema = z.preprocess(
	(value) => ({ in: prop(value, 'in'), name: prop(value, 'name') }),
	z.object({
		in: z.enum(['header', 'query', 'cookie']),
		name: z.string().min(1),
	}),
) satisfies z.ZodType<CredentialLocation, z.ZodTypeDef, unknown>

const gatePathSchema = z.string().startsWith('/')
export const proxyGateRuleSchema = z.preprocess(
	(value) => ({
		path: prop(value, 'path'),
		kind: prop(value, 'kind'),
		credential: prop(value, 'credential'),
	}),
	z.discriminatedUnion('kind', [
		z.object({ path: gatePathSchema, kind: z.literal('public') }),
		z.object({ path: gatePathSchema, kind: z.literal('human') }),
		z.object({ path: gatePathSchema, kind: z.literal('service'), credential: proxyCredentialLocationSchema.nullish() }),
	]).transform((rule) => {
		if (rule.kind !== 'service') return rule
		return { path: rule.path, kind: rule.kind, ...(rule.credential == null ? {} : { credential: rule.credential }) }
	}),
) satisfies z.ZodType<GateRule, z.ZodTypeDef, unknown>

export const proxyAppGatesSchema = z.preprocess(
	(value) => ({ rules: prop(value, 'rules') }),
	z.object({
		rules: z.array(proxyGateRuleSchema),
	}),
) satisfies z.ZodType<AppGates, z.ZodTypeDef, unknown>

export const proxyAppSchema = z.preprocess(
	(value) => ({
		id: prop(value, 'id'),
		hosts: prop(value, 'hosts'),
		upstream: prop(value, 'upstream'),
		gates: prop(value, 'gates'),
		scheme: prop(value, 'scheme'),
	}),
	z.object({
		id: z.string().min(1),
		hosts: z.array(z.string().toLowerCase().refine(isProxyHost)).min(1),
		upstream: z.string().min(1),
		gates: proxyAppGatesSchema,
		scheme: z.preprocess((value) => typeof value === 'string' ? value : undefined, z.enum(['http', 'https']).default('https')),
	}),
) satisfies z.ZodType<ProxyApp, z.ZodTypeDef, unknown>

export const proxyManifestSchema = z.preprocess(
	(value) => ({ apps: prop(value, 'apps') }),
	z.object({
		apps: z.array(proxyAppSchema),
	}).superRefine(({ apps }, ctx) => {
		const ids = new Set<string>()
		const hosts = new Set<string>()
		for (const app of apps) {
			if (ids.has(app.id)) ctx.addIssue({ code: 'custom', message: 'duplicate proxy app id' })
			ids.add(app.id)
			for (const host of app.hosts) {
				if (hosts.has(host)) ctx.addIssue({ code: 'custom', message: 'duplicate proxy host' })
				hosts.add(host)
			}
		}
	}),
) satisfies z.ZodType<ProxyManifest, z.ZodTypeDef, unknown>

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

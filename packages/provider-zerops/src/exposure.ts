// What a deploy reads back before it lets Zerops activate a version (ADR-0043). An import cannot turn subdomain
// access on, but an earlier enable survives it, and Zerops has no API to read a bucket policy back. So every declared
// service must read `subdomainAccess: false`, and every bucket must be one the platform created private.

import type { ZeropsImportResult } from './api'

/**
 * The provenance marker: a service variable on the deploy service listing the object-storage service ids the platform
 * created, each from an import that carried `objectStoragePolicy: private`. A bucket adopted by hostname has none.
 * The import's answer is the only evidence of creation, so `apply-import` records it here before any other step runs.
 */
export const STORAGE_PROVENANCE_KEY = 'FABRIKA_STORAGE_PROVENANCE'

const OBJECT_STORAGE_TYPES: ReadonlySet<string> = new Set(['object-storage', 'objectstorage'])

export const isObjectStorageType = (type: string): boolean => OBJECT_STORAGE_TYPES.has(type)

/** The action of the process an import starts for a service it creates (verified live, 2026-10-02). */
const CREATE_ACTION = 'stack.create'

export const parseStorageProvenance = (value: string | undefined): ReadonlySet<string> =>
	new Set((value ?? '').split(',').filter((entry) => entry !== ''))

export const formatStorageProvenance = (ids: Iterable<string>): string => [...new Set(ids)].sort().join(',')

/** Hostname → service id of every service this import result reports creating. */
export const createdServices = (result: ZeropsImportResult): ReadonlyMap<string, string> =>
	new Map(
		result.services
			.filter((service) => service.processes.some((process) => process.actionName === CREATE_ACTION))
			.map((service) => [service.name, service.id]),
	)

/** How the deploy service holds the marker: a release up to v0.4.2 wrote it sensitive, which reads back without its value. */
export type StorageProvenanceMarker = 'absent' | 'readable' | 'sensitive'

/** The refusal of a bucket no evidence names, with the two remedies an operator has without sudo. */
export const unprovenBucketReason = (input: { bucketId: string; deployService: string; marker: StorageProvenanceMarker }): string => {
	const unreadable = input.marker === 'sensitive'
		? `; \`${STORAGE_PROVENANCE_KEY}\` on \`${input.deployService}\` was written sensitive by an earlier release and cannot be read`
		: ''
	return `is a bucket the platform did not create private (no provenance${unreadable}). If a Fabrika import created it (its \`${CREATE_ACTION}\` process ran under the platform's Zerops token), set \`${STORAGE_PROVENANCE_KEY}\` on \`${input.deployService}\` to \`${input.bucketId}\`, not sensitive; otherwise delete the bucket and deploy again`
}

export interface ExposureFinding {
	readonly hostname: string
	readonly reason: string
}

export const formatExposureFindings = (findings: readonly ExposureFinding[]): string =>
	`zerops: activation refused; ${findings.map((finding) => `service \`${finding.hostname}\` ${finding.reason}`).join('; ')}`

export interface ExposureAlert {
	readonly appId: string
	readonly env: string
	readonly release: string | null
	readonly findings: readonly ExposureFinding[]
}

const DSN_PUBLIC_KEY = /^[0-9a-f]{32}$/
const DSN_PROJECT = /^\/([1-9][0-9]{0,18})$/

/**
 * The Operations ingest request that raises the alert: an error event in the application's own Operations project,
 * which its `new_issue` alert rules deliver. Null for a DSN of any other form. The public key is not a secret, but it
 * travels only in this request.
 */
export function exposureAlertRequest(dsn: string, alert: ExposureAlert, eventId: string): { url: string; body: string } | null {
	let url: URL
	try {
		url = new URL(dsn)
	} catch {
		return null
	}
	const project = DSN_PROJECT.exec(url.pathname)?.[1]
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !DSN_PUBLIC_KEY.test(url.username) || url.password !== '' || project === undefined) {
		return null
	}
	const endpoint = new URL(`/api/${project}/envelope/`, url.origin)
	endpoint.searchParams.set('sentry_key', url.username)
	const event = {
		event_id: eventId,
		level: 'fatal',
		platform: 'other',
		environment: alert.env,
		...(alert.release === null ? {} : { release: alert.release }),
		exception: { values: [{ type: 'FabrikaExposureRefused', value: formatExposureFindings(alert.findings) }] },
		fingerprint: ['fabrika-exposure-refused', alert.appId, alert.env, ...alert.findings.map((finding) => finding.hostname).sort()],
	}
	const body = [JSON.stringify({ event_id: eventId }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n')
	return { url: endpoint.toString(), body: `${body}\n` }
}

export type ExposureAlerter = (input: { readonly dsn: string; readonly alert: ExposureAlert; readonly signal: AbortSignal }) => Promise<void>

/** Send the alert. The caller treats a failure as non-fatal: the refusal stands either way. */
export const sendExposureAlert: ExposureAlerter = async ({ dsn, alert, signal }) => {
	const request = exposureAlertRequest(dsn, alert, crypto.randomUUID().replaceAll('-', ''))
	if (request === null) throw new Error('zerops: the Operations DSN has an unexpected form')
	const response = await fetch(request.url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-sentry-envelope' },
		body: request.body,
		signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
	})
	if (!response.ok) throw new Error(`zerops: the Operations ingest answered ${response.status}`)
}

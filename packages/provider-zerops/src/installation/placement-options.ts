import { z } from 'zod'

const scheme = z.enum(['http', 'https']).default('https')
// Lowercased because every consumer compares origins as `URL` writes them, and `URL` lowercases the host.
const bareHostname = z.string().refine(
	(host) => !host.includes('/') && !host.includes(':'),
	(host) => ({ message: `\`${host}\` is not a bare hostname — a platform host carries no scheme and no port` }),
).transform((host) => host.toLowerCase())
const hosts = z.object({ iam: bareHostname, control: bareHostname, operations: bareHostname })

export const parsePlatformScheme = (raw: string | undefined): 'http' | 'https' => {
	const parsed = scheme.safeParse(raw)
	if (!parsed.success) throw new Error('--scheme must be http or https')
	return parsed.data
}
export const parsePlatformHostname = (raw: string): string => {
	const parsed = bareHostname.safeParse(raw)
	if (!parsed.success) throw new Error(`\`${raw}\` is not a bare hostname — a platform host carries no scheme and no port`)
	return parsed.data
}
export const parsePlatformHosts = (
	raw: { iam: string | undefined; control: string | undefined; operations: string | undefined },
): { iam: string; control: string; operations: string } | undefined => {
	if (raw.iam === undefined && raw.control === undefined && raw.operations === undefined) return undefined
	const parsed = hosts.safeParse(raw)
	if (parsed.success) return parsed.data
	if (raw.iam === undefined || raw.control === undefined || raw.operations === undefined) {
		throw new Error(
			'name every platform host or none: --iam-host, --console-host and --operations-host go together '
				+ "(omitting all three derives them from the proxy's Zerops subdomains)",
		)
	}
	throw new Error(parsed.error.issues[0]?.message ?? 'invalid platform hosts')
}

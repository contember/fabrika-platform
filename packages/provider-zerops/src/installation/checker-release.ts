import { FABRIKA_CHECK_VERSION } from '../execution'

/** The package every contract application build fetches by this checkout's version. */
export const FABRIKA_CHECK_PACKAGE = '@fabrika/check'

/** Whether npm has `@fabrika/check` at `version`. Throws when it cannot tell. */
export type CheckerPublication = (version: string, signal: AbortSignal) => Promise<boolean>

const NPM_REGISTRY = 'https://registry.npmjs.org'

export type RegistryFetch = (url: string, init: RequestInit) => Promise<Response>

export const npmCheckerPublication = (fetchImpl: RegistryFetch = (url, init) => fetch(url, init)): CheckerPublication => async (version, signal) => {
	const url = `${NPM_REGISTRY}/${FABRIKA_CHECK_PACKAGE.replace('/', '%2F')}/${encodeURIComponent(version)}`
	let response: Response
	try {
		response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal })
	} catch {
		signal.throwIfAborted()
		throw new Error(`could not reach npm to check that ${FABRIKA_CHECK_PACKAGE}@${version} is published; retry when npm answers`)
	}
	await response.body?.cancel()
	if (response.ok) return true
	if (response.status === 404) return false
	throw new Error(`npm answered ${response.status} for ${FABRIKA_CHECK_PACKAGE}@${version}; retry when npm answers`)
}

/**
 * Refuse a checkout whose checker npm does not have. Every contract application build of the installation fetches
 * `@fabrika/check` at this checkout's version, so without it no application could deploy. Between a release's bump
 * commit and its publish, `main` is such a checkout.
 */
export const assertCheckerPublished = async (
	published: CheckerPublication,
	signal: AbortSignal,
	version: string = FABRIKA_CHECK_VERSION,
): Promise<void> => {
	if (await published(version, signal)) return
	throw new Error(
		`this checkout is version ${version}, which is not published yet: npm has no ${FABRIKA_CHECK_PACKAGE}@${version}, and every `
			+ 'application build of this installation fetches it. Deploy a released tag of contember/fabrika-platform, '
			+ `or wait until v${version} is published.`,
	)
}

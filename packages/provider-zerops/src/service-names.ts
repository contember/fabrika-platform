import { ZEROPS_SERVICE_HOSTNAME_PATTERN } from './manifest'

const SHARED_PREFIX_MAX_LENGTH = 12
const LOCAL_SERVICE_PATTERN = /^[a-z0-9]+$/

const fnv1a = (value: string): number => {
	let hash = 0x811c9dc5
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

/** Deterministic app prefix for services placed in a shared Zerops namespace. */
export const zeropsSharedServicePrefix = (appId: string): string => {
	if (/^[a-z0-9]{1,12}$/.test(appId)) {
		return appId
	}
	const normalized = appId.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
	if (normalized === '') {
		throw new Error('Zerops shared service prefix requires an app id containing a letter or number')
	}
	const hash = fnv1a(appId).toString(36).padStart(7, '0')
	return `${normalized.slice(0, 5)}${hash}`.slice(0, SHARED_PREFIX_MAX_LENGTH)
}

/** Build one app-owned service hostname for a shared namespace. */
export const zeropsSharedServiceHostname = (appId: string, localService: string): string => {
	if (!LOCAL_SERVICE_PATTERN.test(localService)) {
		throw new Error('Zerops local service name must contain lowercase letters and numbers only')
	}
	const hostname = `${zeropsSharedServicePrefix(appId)}${localService}`
	if (!ZEROPS_SERVICE_HOSTNAME_PATTERN.test(hostname)) {
		throw new Error(`Zerops shared service hostname \`${hostname}\` exceeds the 25-character platform limit`)
	}
	return hostname
}

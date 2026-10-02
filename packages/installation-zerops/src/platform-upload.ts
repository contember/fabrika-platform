export type PlatformUploadFetch = (url: string, init: RequestInit) => Promise<Response>

const UPLOAD_HOST = 'proxy.app-prg1.zerops.io'
const UPLOAD_PATH = '/api/rest/object-storage/upload'

// Keep this native destination policy aligned with source-zerops/service.ts (a private package).
export const validatePlatformUploadUrl = (value: string): void => {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('Zerops archive upload destination rejected')
	}
	if (
		!value.startsWith(`https://${UPLOAD_HOST}${UPLOAD_PATH}?`) || url.protocol !== 'https:' || url.hostname !== UPLOAD_HOST
		|| url.port !== '' || url.pathname !== UPLOAD_PATH || url.search === '' || url.username !== '' || url.password !== '' || url.hash !== ''
	) {
		throw new Error('Zerops archive upload destination rejected')
	}
}

export const uploadPlatformArchive = async (
	url: string,
	archivePath: string,
	signal: AbortSignal,
	uploadFetch: PlatformUploadFetch,
): Promise<void> => {
	validatePlatformUploadUrl(url)
	const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
	const body = Bun.file(archivePath).stream()
	try {
		const response = await uploadFetch(url, {
			method: 'PUT',
			body,
			redirect: 'error',
			signal: uploadSignal,
		})
		await response.body?.cancel()
		if (uploadSignal.aborted || !response.ok) throw new Error('upload rejected')
	} catch {
		throw new Error('Zerops archive upload failed')
	} finally {
		if (!body.locked) await body.cancel().catch(() => {})
	}
}

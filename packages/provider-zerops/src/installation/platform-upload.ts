import { isZeropsUploadDestination } from '../index'

export type PlatformUploadFetch = (url: string, init: RequestInit) => Promise<Response>

export const validatePlatformUploadUrl = (value: string): void => {
	if (!isZeropsUploadDestination(value)) {
		throw new Error('Zerops archive upload destination rejected')
	}
}

export const uploadPlatformArchive = async (
	url: string,
	archive: Blob,
	signal: AbortSignal,
	uploadFetch: PlatformUploadFetch,
): Promise<void> => {
	validatePlatformUploadUrl(url)
	const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
	const body = archive.stream()
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

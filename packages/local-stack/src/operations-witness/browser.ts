import * as Sentry from '@sentry/browser'
import { parseOperationsConfig } from './operations-config'

const configResponse = await fetch('/operations-sdk/config')
if (!configResponse.ok) throw new Error('Operations SDK configuration is unavailable')
const config = parseOperationsConfig(await configResponse.json())

Sentry.init({
	dsn: config.dsn,
	release: config.release,
	defaultIntegrations: false,
})

const captureButton = document.querySelector<HTMLButtonElement>('#capture-error')
const captureStatus = document.querySelector<HTMLElement>('#capture-status')
const markerInput = document.querySelector<HTMLInputElement>('#error-marker')
if (captureButton === null || captureStatus === null || markerInput === null) throw new Error('Operations SDK witness markup is incomplete')
const marker = sessionMarker()
markerInput.value = marker

captureButton.addEventListener('click', async () => {
	try {
		throwManagedError(marker)
	} catch (error) {
		const eventId = Sentry.withScope((scope) => {
			scope.setFingerprint([marker])
			return Sentry.captureException(error)
		})
		captureStatus.textContent = (await Sentry.flush(2_000)) ? `Sent ${eventId}` : `Timed out ${eventId}`
	}
})

function throwManagedError(eventMarker: string): never {
	throw new Error(`Fabrika Operations SDK witness [${eventMarker}]`)
}

function sessionMarker(): string {
	const requested = new URLSearchParams(location.search).get('marker')
	if (requested !== null && /^[0-9a-f-]{36}$/.test(requested)) {
		sessionStorage.setItem('fabrika-operations-sdk-marker', requested)
		return requested
	}
	const stored = sessionStorage.getItem('fabrika-operations-sdk-marker')
	if (stored !== null && /^[0-9a-f-]{36}$/.test(stored)) return stored
	const created = crypto.randomUUID()
	sessionStorage.setItem('fabrika-operations-sdk-marker', created)
	return created
}

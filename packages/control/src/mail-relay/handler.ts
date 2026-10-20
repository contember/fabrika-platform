import { platformMailAnswerResponse } from '@fabrika/email/platform'
import type { ControlAppContext } from '../app'

/** `POST /platform/mail/*`: the platform transport's mail receiver. Until the relay lands it takes no message. */
export function handleMailRelay(_ctx: ControlAppContext): Promise<Response> {
	return Promise.resolve(platformMailAnswerResponse({ error: { code: 'provider_unavailable' } }))
}

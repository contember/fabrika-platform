// A public registration that carries a photo (the form takes files): the photo waits, owned by nobody, until the intake
// job creates the candidate and attaches it; a scan clears it before anyone downloads it. A second form requires its file.

import { app } from './src/app-kit'
import { intake } from './src/intake/endpoints'
import { Apply, Register } from './src/schemas'

/** Small enough for a test to send one file over it. */
export const PHOTO_MAX_BYTES = 4096

export const contract = app.contract((c) => ({
	register: c.form('/register', {
		input: Register,
		appendTo: 'registrations',
		maxBytes: 2048,
		honeypot: 'website',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		files: { photo: { collection: 'photos' } },
		crossOrigin: true,
	}),
	apply: c.form('/apply', {
		input: Apply,
		appendTo: 'applications',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		files: { portrait: { collection: 'photos', required: true } },
	}),
	files: {
		photos: c.files({
			owner: 'candidates',
			read: 'candidates.read',
			write: 'candidates.attach',
			delete: 'candidates.review',
			maxBytes: PHOTO_MAX_BYTES,
			types: ['image/jpeg', 'image/png'],
			maxPerOwner: 2,
			scan: true,
		}),
	},
	jobs: { intake },
}))

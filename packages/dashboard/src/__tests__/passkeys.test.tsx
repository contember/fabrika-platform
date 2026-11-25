// The console's half of the passkey ceremonies: IAM's JSON options become what `navigator.credentials` takes, the
// browser's answer becomes IAM's JSON again, a step-up asks for its challenge first, and the page and the prompt render
// their controls and refusals. The browser is a stand-in that records what it was asked.

import { PASSKEY_REGISTRATION_BINDING, type PasskeyCreationOptions, type PasskeyDto, type PasskeyRequestOptions } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { StepUpPrompt } from '../components/StepUpPrompt'
import {
	assertPasskey,
	ceremonyFailure,
	createPasskey,
	creationOptions,
	fromBase64Url,
	PasskeyCeremonyError,
	type PasskeyCredentials,
	stepUpWithPasskey,
	toBase64Url,
} from '../lib/webauthn'
import { addPasskey, Passkeys } from '../routes/account/passkeys'

const bytes = (...values: number[]) => Uint8Array.from(values).buffer

const CREATION: PasskeyCreationOptions = {
	rp: { id: 'console.example.test', name: 'console.example.test' },
	user: { id: toBase64Url(new TextEncoder().encode('principal-1')), name: 'ada@example.test', displayName: 'ada@example.test' },
	challenge: toBase64Url(bytes(1, 2, 3)),
	pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
	timeout: 300_000,
	excludeCredentials: [{ type: 'public-key', id: toBase64Url(bytes(9)), transports: ['internal', 'carrier-pigeon'] }],
	authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
	attestation: 'none',
}

const REQUEST: PasskeyRequestOptions = {
	challenge: toBase64Url(bytes(4, 5, 6)),
	rpId: 'console.example.test',
	timeout: 300_000,
	allowCredentials: [{ type: 'public-key', id: toBase64Url(bytes(7, 7)) }],
	userVerification: 'required',
}

/** A browser that answers fixed credentials and keeps what it was asked. */
function browser(answers: { create?: unknown; get?: unknown } = {}) {
	const asked: { create: CredentialCreationOptions[]; get: CredentialRequestOptions[] } = { create: [], get: [] }
	const credentials: PasskeyCredentials = {
		create: (options) => {
			asked.create.push(options)
			return Promise.resolve(answers.create ?? null)
		},
		get: (options) => {
			asked.get.push(options)
			return Promise.resolve(answers.get ?? null)
		},
	}
	return { credentials, asked }
}

const ATTESTED = {
	type: 'public-key',
	rawId: bytes(0xfb, 0xff),
	response: { clientDataJSON: bytes(1), attestationObject: bytes(2) },
}

const ASSERTED = {
	type: 'public-key',
	rawId: bytes(0xfb, 0xff),
	response: { clientDataJSON: bytes(1), authenticatorData: bytes(2), signature: bytes(3), userHandle: null },
}

describe('base64url', () => {
	test('round-trips bytes without padding or the URL-unsafe characters', () => {
		const value = bytes(0xfb, 0xff, 0xfe, 0x00)
		expect(toBase64Url(value)).toBe('-__-AA')
		expect(new Uint8Array(fromBase64Url('-__-AA'))).toEqual(new Uint8Array(value))
	})
})

describe('the ceremonies', () => {
	test("IAM's creation options become bytes where WebAuthn takes bytes, and an unknown transport is dropped", () => {
		const publicKey = creationOptions(CREATION).publicKey
		expect(publicKey?.user.id).toEqual(fromBase64Url(CREATION.user.id))
		expect(publicKey?.challenge).toEqual(bytes(1, 2, 3))
		expect(publicKey?.excludeCredentials).toEqual([{ type: 'public-key', id: bytes(9), transports: ['internal'] }])
	})

	test("the browser's answers become IAM's JSON encoding", async () => {
		const registered = await createPasskey(browser({ create: ATTESTED }).credentials, CREATION)
		expect(registered).toEqual({ id: '-_8', rawId: '-_8', type: 'public-key', response: { clientDataJSON: 'AQ', attestationObject: 'Ag' } })
		const asserted = await assertPasskey(browser({ get: ASSERTED }).credentials, REQUEST)
		expect(asserted).toEqual({
			id: '-_8',
			rawId: '-_8',
			type: 'public-key',
			response: { clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw' },
		})
	})

	test('no credential, or one that is not a public key, is a refusal in words', async () => {
		const missing = await createPasskey(browser().credentials, CREATION).catch((cause: unknown) => cause)
		expect(missing).toBeInstanceOf(PasskeyCeremonyError)
		const other = await assertPasskey(browser({ get: { ...ASSERTED, type: 'password' } }).credentials, REQUEST).catch((cause: unknown) => cause)
		expect(ceremonyFailure(other)).toBe('The browser answered no passkey.')
		expect(ceremonyFailure(new DOMException('cancelled', 'NotAllowedError'))).toBe('The passkey prompt was cancelled or timed out. Try again.')
	})

	test('a step-up asks for its challenge first and answers it under its id', async () => {
		const { credentials, asked } = browser({ get: ASSERTED })
		const assertion = await stepUpWithPasskey(credentials, () => Promise.resolve({ challengeId: 'challenge-1', expiresAt: 0, options: REQUEST }))
		expect(assertion.challengeId).toBe('challenge-1')
		expect(asked.get[0]?.publicKey?.challenge).toEqual(bytes(4, 5, 6))
	})

	test('adding a passkey beside one takes a step-up bound to the registration first; the first one does not', async () => {
		for (const hasPasskey of [false, true]) {
			const bindings: string[] = []
			const sent: unknown[] = []
			const passkey: PasskeyDto = { id: 'p', label: 'Laptop', createdAt: 1, lastUsedAt: null }
			await addPasskey(
				browser({ create: ATTESTED, get: ASSERTED }).credentials,
				{
					challenge: ({ binding }) => {
						bindings.push(binding)
						return Promise.resolve({ challengeId: 'step-up', expiresAt: 0, options: REQUEST })
					},
					registrationOptions: () => Promise.resolve({ challengeId: 'registration', expiresAt: 0, options: CREATION }),
					register: (input) => {
						sent.push(input)
						return Promise.resolve(passkey)
					},
				},
				'Laptop',
				hasPasskey,
			)
			expect(bindings).toEqual(hasPasskey ? [PASSKEY_REGISTRATION_BINDING] : [])
			expect(sent).toEqual([expect.objectContaining({ challengeId: 'registration', label: 'Laptop' })])
			expect(sent.map((input) => typeof input === 'object' && input !== null && 'stepUp' in input)).toEqual([hasPasskey])
		}
	})
})

describe('the controls', () => {
	test('the step-up prompt is a labelled button, and says so where the browser has no passkeys', () => {
		const prompt = renderToStaticMarkup(
			<StepUpPrompt
				credentials={browser().credentials}
				fetchChallenge={() => Promise.reject(new Error('unused'))}
				onAsserted={() => Promise.resolve()}
			/>,
		)
		expect(prompt).toContain('<button type="button" aria-busy="false">Verify with a passkey</button>')
		const unsupported = renderToStaticMarkup(
			<StepUpPrompt credentials={null} fetchChallenge={() => Promise.reject(new Error('unused'))} onAsserted={() => Promise.resolve()} />,
		)
		expect(unsupported).toContain('role="alert"')
	})

	test('the page lists the passkeys with a named remove button each, and offers to add one', () => {
		const page = renderToStaticMarkup(
			<Passkeys
				passkeys={[{ id: 'p1', label: 'Work laptop', createdAt: 1, lastUsedAt: null }]}
				onChanged={() => {}}
				credentials={browser().credentials}
			/>,
		)
		expect(page).toContain('Work laptop')
		expect(page).toContain('Remove <span class="sr-only">Work laptop</span>')
		expect(page).toContain('Add passkey')
		expect(page).toContain('asks for a passkey you already have first')
		const empty = renderToStaticMarkup(<Passkeys passkeys={[]} onChanged={() => {}} credentials={null} />)
		expect(empty).toContain('No passkey yet')
		expect(empty).not.toContain('Add passkey')
	})
})

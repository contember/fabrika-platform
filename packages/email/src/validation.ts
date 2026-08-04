import { EmailDeliveryError, type EmailMessage } from './email.js'

const DOT_ATOM_CHARACTER = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

export function isValidEmailAddress(value: string): boolean {
	if (value.length === 0 || value.length > 254 || value.trim() !== value || containsControlCharacter(value)) return false

	const separator = value.indexOf('@')
	if (separator <= 0 || separator !== value.lastIndexOf('@')) return false

	const local = value.slice(0, separator)
	const domain = value.slice(separator + 1)
	if (local.length > 64 || domain.length === 0 || domain.length > 253 || !domain.includes('.')) return false
	if (!local.split('.').every((part) => part.length > 0 && DOT_ATOM_CHARACTER.test(part))) return false

	return domain.split('.').every((label) => label.length <= 63 && DOMAIN_LABEL.test(label))
}

export function isValidEmailFrom(value: string): boolean {
	if (isValidEmailAddress(value)) return true
	if (value.length === 0 || value.length > 384 || value.trim() !== value || containsControlCharacter(value) || !value.endsWith('>')) return false

	const openingBracket = value.lastIndexOf('<')
	if (openingBracket <= 0 || value.indexOf('<') !== openingBracket || value.indexOf('>') !== value.length - 1) return false

	const displayName = value.slice(0, openingBracket).trim()
	const address = value.slice(openingBracket + 1, -1)
	return displayName.length > 0 && displayName.length <= 128 && !displayName.includes('<') && !displayName.includes('>')
		&& isValidEmailAddress(address)
}

export function validateEmailMessage(message: EmailMessage): void {
	if (!isValidEmailAddress(message.to)) throw invalidMessage('Email recipient is invalid')
	if (message.subject.length === 0 || message.subject.length > 998 || containsControlCharacter(message.subject)) {
		throw invalidMessage('Email subject is invalid')
	}
	if (message.text.trim().length === 0) throw invalidMessage('Email text is empty')
	if (message.idempotencyKey.length === 0 || message.idempotencyKey.length > 256 || !isVisibleAscii(message.idempotencyKey)) {
		throw invalidMessage('Email idempotency key is invalid')
	}
}

function invalidMessage(message: string): EmailDeliveryError {
	return new EmailDeliveryError(message, { code: 'invalid_message', retryable: false })
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 32 || code === 127) return true
	}
	return false
}

function isVisibleAscii(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 33 || code > 126) return false
	}
	return true
}

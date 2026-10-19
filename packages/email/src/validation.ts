import type { EmailSenderIdentity } from './config.js'
import { attachmentBytes, EmailDeliveryError, type EmailMessage, type EmailSenderCapabilities } from './email.js'

/** The longest subject a message may have, in UTF-16 code units: RFC 5322's line limit. */
export const MAX_EMAIL_SUBJECT_LENGTH = 998

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

/** A mailbox address, or the legacy `Name <address>` form. */
export function isValidEmailFrom(value: string): boolean {
	return parseEmailFrom(value) !== null
}

/**
 * Splits a bare address or the legacy `Name <address>` form. A name in one pair of double quotes loses them, since a
 * transport quotes the name itself when it has to.
 */
export function parseEmailFrom(value: string): EmailSenderIdentity | null {
	if (isValidEmailAddress(value)) return { address: value }
	if (value.length === 0 || value.length > 384 || value.trim() !== value || containsControlCharacter(value) || !value.endsWith('>')) return null

	const openingBracket = value.lastIndexOf('<')
	if (openingBracket <= 0 || value.indexOf('<') !== openingBracket || value.indexOf('>') !== value.length - 1) return null

	const displayName = unquoted(value.slice(0, openingBracket).trim())
	const address = value.slice(openingBracket + 1, -1)
	if (!isValidEmailDisplayName(displayName) || !isValidEmailAddress(address)) return null
	return { address, name: displayName }
}

/** 1..128 characters, no control characters and none of `<>"\`, so a transport can always quote it. */
export function isValidEmailDisplayName(value: string): boolean {
	return value.length > 0 && value.length <= 128 && !containsControlCharacter(value) && !/[<>"\\]/.test(value)
}

export function isValidEmailSenderIdentity(identity: EmailSenderIdentity): boolean {
	return isValidEmailAddress(identity.address) && (identity.name === undefined || isValidEmailDisplayName(identity.name))
}

export function validateEmailMessage(message: EmailMessage): void {
	if (!isValidEmailAddress(message.to)) throw invalidMessage('Email recipient is invalid')
	if (message.subject.length === 0 || message.subject.length > MAX_EMAIL_SUBJECT_LENGTH || containsControlCharacter(message.subject)) {
		throw invalidMessage('Email subject is invalid')
	}
	if (message.text.trim().length === 0) throw invalidMessage('Email text is empty')
	if (message.idempotencyKey.length === 0 || message.idempotencyKey.length > 256 || !isVisibleAscii(message.idempotencyKey)) {
		throw invalidMessage('Email idempotency key is invalid')
	}
	if (message.replyTo !== undefined && !isValidEmailAddress(message.replyTo)) throw invalidMessage('Email reply-to address is invalid')
	if (message.fromName !== undefined && !isValidEmailDisplayName(message.fromName)) throw invalidMessage('Email sender name is invalid')
	if (message.unsubscribeUrl !== undefined && !isUnsubscribeUrl(message.unsubscribeUrl)) throw invalidMessage('Email unsubscribe URL is invalid')
	const attachments = message.attachments ?? []
	if (attachments.length > MAX_EMAIL_ATTACHMENTS) throw invalidMessage(`Email has more than ${MAX_EMAIL_ATTACHMENTS} attachments`)
	for (const attachment of attachments) {
		if (!isValidAttachmentFilename(attachment.filename)) throw invalidMessage('Email attachment name is invalid')
		if (!MEDIA_TYPE.test(attachment.contentType)) throw invalidMessage('Email attachment type is invalid')
	}
}

/**
 * Refuses a message whose attachments `capabilities` does not carry: any attachment where the transport sends none, or
 * more bytes together than its `maxAttachmentBytes`. `label` names the transport in the message.
 */
export function validateEmailAttachments(message: EmailMessage, capabilities: EmailSenderCapabilities, label: string): void {
	if ((message.attachments ?? []).length === 0) return
	const limit = capabilities.maxAttachmentBytes
	if (limit === undefined) throw invalidMessage(`${label} sends no attachments`)
	const bytes = attachmentBytes(message)
	if (bytes > limit) throw invalidMessage(`Email attachments have ${bytes} bytes, more than the ${limit} ${label} sends`)
}

/** The most files one message carries. */
export const MAX_EMAIL_ATTACHMENTS = 20

const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/

/** 1..255 characters, no control characters, no path separator and no `"`, so every transport can quote it. */
export function isValidAttachmentFilename(value: string): boolean {
	return value.length > 0 && value.length <= 255 && value.trim() === value && !containsControlCharacter(value) && !/[/\\"]/.test(value)
}

/** The longest unsubscribe URL a header carries: one header line, with room for its name. */
export const MAX_UNSUBSCRIBE_URL_LENGTH = 2048

/** An absolute `https:` URL as it is written, which a `<…>` header value carries unchanged. */
export function isUnsubscribeUrl(value: string): boolean {
	if (value.length > MAX_UNSUBSCRIBE_URL_LENGTH || containsControlCharacter(value) || /[\s<>"]/.test(value)) return false
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.href === value && url.username === '' && url.password === ''
	} catch {
		return false
	}
}

function invalidMessage(message: string): EmailDeliveryError {
	return new EmailDeliveryError(message, { code: 'invalid_message' })
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 32 || code === 127) return true
	}
	return false
}

function unquoted(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

export function isVisibleAscii(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 33 || code > 126) return false
	}
	return true
}

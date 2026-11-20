// IAM's own e-mails, in every language it speaks, and how an application's wording of them (`mail`, `MailTemplate`)
// is rendered. IAM sends them; `fabrika app dev`'s stand-in IAM shows the same messages, so both read them from here
// and a preview never drifts from what IAM sends. A value is plain text: every one is escaped where HTML inserts it.

import { DEFAULT_LOCALE, type Locale } from './locale'
import {
	fillMailTemplate,
	type MailHtmlToken,
	mailHtmlTokens,
	type MailPlaceholder,
	type MailTemplate,
	mailTemplateProblems,
	type MessageKind,
} from './mail'

/** A rendered e-mail: the subject and both bodies, from the same values. */
export interface RenderedMessage {
	readonly subject: string
	readonly text: string
	readonly html: string
}

/**
 * How the owner of an invitation's mailbox accepts it. `create`: no principal holds the mailbox and accepting creates
 * one with the password its owner chooses (ADR-0051). `sign_in`: a principal holds it, or single sign-on would admit
 * it, so its owner signs in and accepts. `no_account`: neither, so the owner cannot accept until someone gives the
 * mailbox an account.
 */
export type InvitationAcceptance = 'create' | 'sign_in' | 'no_account'

export interface PasswordActionValues {
	/** The application the action returns to; `null` for an action on the installation itself. */
	readonly appName: string | null
	readonly recipient: string
	readonly actionUrl: string
	readonly expiresAt: number
}

/**
 * The closed set of values each IAM message is rendered from. Every value is plain text; a template escapes it. IAM
 * builds the action URL itself, and a template places it. `expiresAt` is the link's expiry in seconds since the epoch.
 */
export interface MessageValues {
	readonly invitation: {
		readonly appName: string
		readonly role: string
		readonly scope: string
		readonly recipient: string
		readonly inviterLabel: string
		/** The invited person's company, as the inviting application names it; empty when the invitation names none. */
		readonly companyLabel: string
		/** The inviter's personal message; empty when the invitation carries none. */
		readonly message: string
		readonly actionUrl: string
		readonly expiresAt: number
		/** How the mailbox's owner accepts, as IAM can tell when it sends; it picks IAM's words, and is no placeholder. */
		readonly acceptance: InvitationAcceptance
	}
	readonly enrollment: PasswordActionValues
	readonly reset: PasswordActionValues
}

/** One template per message. IAM's catalog supplies a default set per language. */
export type MessageTemplates = { readonly [K in MessageKind]: (values: MessageValues[K]) => RenderedMessage }

/** IAM's words around an application's own wording of a message: the HTML part's button and the expiry. */
export interface ApplicationMailText {
	readonly button: { readonly [K in MessageKind]: string }
	/** `expiresAt` in seconds since the epoch, as the `{{expiry}}` placeholder shows it. */
	readonly expiry: (expiresAt: number) => string
}

/** IAM's wording of its e-mails in one language. */
export interface IamMailCatalog {
	readonly messages: MessageTemplates
	readonly applicationMail: ApplicationMailText
}

/** Escape a value for HTML text and a quoted attribute, as IAM's pages do. */
function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** The HTML of an inviter's personal message: its introduction, then the message escaped and quoted, line breaks kept. */
function quotedNote(note: { readonly intro: string; readonly message: string } | null): string {
	if (note === null) return ''
	const paragraphs = note.message.replaceAll('\r\n', '\n').split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '')
	const quoted = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`).join('')
	return `<p>${escapeHtml(note.intro)}</p><blockquote>${quoted}</blockquote>`
}

/** An invitation in one language's words: the sentence of what it gives, the note's introduction, how to accept. */
interface InvitationWords {
	readonly subject: (appName: string) => string
	readonly invited: (what: string) => string
	readonly what: (values: { readonly appName: string; readonly role: string; readonly scope: string; readonly companyLabel: string }) => string
	readonly writes: (inviterLabel: string) => string
	readonly accept: { readonly [A in InvitationAcceptance]: string }
	readonly button: string
	readonly ignore: string
}

function invitationMessage(words: InvitationWords): MessageTemplates['invitation'] {
	return ({ appName, role, scope, inviterLabel, companyLabel, message, actionUrl, acceptance }) => {
		const what = words.what({ appName, role, scope, companyLabel })
		const note = message === '' ? null : { intro: words.writes(inviterLabel), message }
		const accept = words.accept[acceptance]
		return {
			subject: words.subject(appName),
			text: [words.invited(what), ...(note === null ? [] : [note.intro, note.message]), accept, actionUrl, words.ignore].join('\n\n'),
			html: `<p>${escapeHtml(words.invited(what))}</p>${quotedNote(note)}<p>${escapeHtml(accept)}</p><p><a href="${escapeHtml(actionUrl)}">${
				escapeHtml(words.button)
			}</a></p><p>${escapeHtml(words.ignore)}</p>`,
		}
	}
}

/** A password message in one language's words: the link sentence before the link, and the closing line. */
function passwordMessage(intro: (action: string) => string, ignore: string) {
	return (subject: string, action: string, actionUrl: string): RenderedMessage => ({
		subject,
		text: `${intro(action)}\n\n${actionUrl}\n\n${ignore}`,
		html: `<p>${escapeHtml(intro(action))}</p><p><a href="${escapeHtml(actionUrl)}">${escapeHtml(subject)}</a></p><p>${escapeHtml(ignore)}</p>`,
	})
}

const expiryIn = (tag: string): ApplicationMailText['expiry'] => {
	const format = new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })
	return (expiresAt) => `${format.format(new Date(expiresAt * 1000))} UTC`
}

function enCatalog(): IamMailCatalog {
	const password = passwordMessage((action) => `Use this one-time link to ${action}:`, 'If you did not request this, you can ignore this email.')
	return {
		messages: {
			invitation: invitationMessage({
				subject: (appName) => `You are invited to ${appName}`,
				invited: (what) => `You are invited to join a ${what}.`,
				what: ({ appName, role, scope, companyLabel }) => `${scope} of ${appName} as ${role}${companyLabel === '' ? '' : `, for ${companyLabel}`}`,
				writes: (inviterLabel) => `${inviterLabel} writes:`,
				accept: {
					create: 'Open this one-time link to accept. With an account here, sign in with this address first; without one, you choose a password.',
					sign_in: 'Open this one-time link and sign in with this address to accept.',
					no_account:
						'There is no account for this address here yet, and this invitation does not create one. Ask the person who invited you to have one set up, then open this one-time link and sign in to accept.',
				},
				button: 'Accept the invitation',
				ignore: 'If you did not expect this, you can ignore this email.',
			}),
			enrollment: ({ appName, actionUrl }) =>
				password(
					appName === null ? 'Set your Fabrika password' : `Set your password for ${appName}`,
					appName === null ? 'set your Fabrika password' : `set your password for ${appName}`,
					actionUrl,
				),
			reset: ({ appName, actionUrl }) =>
				password(
					appName === null ? 'Reset your Fabrika password' : `Reset your password for ${appName}`,
					appName === null ? 'reset your Fabrika password' : `reset your password for ${appName}`,
					actionUrl,
				),
		},
		applicationMail: {
			button: { invitation: 'Accept the invitation', enrollment: 'Set your password', reset: 'Reset your password' },
			expiry: expiryIn('en-GB'),
		},
	}
}

function csCatalog(): IamMailCatalog {
	const password = passwordMessage((action) => `Tímto jednorázovým odkazem ${action}:`, 'Pokud jste o to nežádali, můžete tento e-mail ignorovat.')
	return {
		messages: {
			invitation: invitationMessage({
				subject: (appName) => `Pozvánka do aplikace ${appName}`,
				invited: (what) => `Dostali jste pozvánku ${what}.`,
				what: ({ appName, role, scope, companyLabel }) =>
					`do aplikace ${appName} s rolí ${role} (${scope})${companyLabel === '' ? '' : ` za ${companyLabel}`}`,
				writes: (inviterLabel) => `${inviterLabel} píše:`,
				accept: {
					create: 'Pozvánku přijmete tímto jednorázovým odkazem. Máte-li zde účet, nejprve se přihlaste touto adresou; pokud ho nemáte, zvolíte si heslo.',
					sign_in: 'Pozvánku přijmete tímto jednorázovým odkazem po přihlášení touto adresou.',
					no_account:
						'Pro tuto adresu tu zatím není účet a tato pozvánka ho nezakládá. Požádejte toho, kdo vás pozval, aby vám ho zřídil; potom pozvánku přijmete tímto jednorázovým odkazem po přihlášení.',
				},
				button: 'Přijmout pozvánku',
				ignore: 'Pokud jste pozvánku nečekali, můžete tento e-mail ignorovat.',
			}),
			enrollment: ({ appName, actionUrl }) =>
				password(appName === null ? 'Nastavení hesla' : `Nastavení hesla pro aplikaci ${appName}`, 'si nastavíte heslo', actionUrl),
			reset: ({ appName, actionUrl }) =>
				password(appName === null ? 'Obnovení hesla' : `Obnovení hesla pro aplikaci ${appName}`, 'si obnovíte heslo', actionUrl),
		},
		applicationMail: {
			button: { invitation: 'Přijmout pozvánku', enrollment: 'Nastavit heslo', reset: 'Obnovit heslo' },
			expiry: expiryIn('cs'),
		},
	}
}

function ukCatalog(): IamMailCatalog {
	const password = passwordMessage(
		(action) => `Скористайтеся цим одноразовим посиланням, щоб ${action}:`,
		'Якщо ви цього не запитували, просто проігноруйте цей лист.',
	)
	return {
		messages: {
			invitation: invitationMessage({
				subject: (appName) => `Запрошення до застосунку ${appName}`,
				invited: (what) => `Вас запрошено ${what}.`,
				what: ({ appName, role, scope, companyLabel }) =>
					`до застосунку ${appName} з роллю ${role} (${scope})${companyLabel === '' ? '' : `, організація: ${companyLabel}`}`,
				writes: (inviterLabel) => `${inviterLabel} пише:`,
				accept: {
					create:
						'Щоб прийняти запрошення, відкрийте це одноразове посилання. Якщо у вас тут уже є обліковий запис, спочатку увійдіть із цією адресою; якщо немає, ви створите пароль.',
					sign_in: 'Щоб прийняти запрошення, відкрийте це одноразове посилання й увійдіть із цією адресою.',
					no_account:
						'Для цієї адреси тут ще немає облікового запису, і це запрошення його не створює. Попросіть того, хто вас запросив, створити його, а потім відкрийте це одноразове посилання й увійдіть, щоб прийняти запрошення.',
				},
				button: 'Прийняти запрошення',
				ignore: 'Якщо ви не очікували цього запрошення, просто проігноруйте цей лист.',
			}),
			enrollment: ({ appName, actionUrl }) =>
				password(appName === null ? 'Створення пароля' : `Створення пароля для застосунку ${appName}`, 'створити пароль', actionUrl),
			reset: ({ appName, actionUrl }) =>
				password(appName === null ? 'Відновлення пароля' : `Відновлення пароля для застосунку ${appName}`, 'відновити пароль', actionUrl),
		},
		applicationMail: {
			button: { invitation: 'Прийняти запрошення', enrollment: 'Створити пароль', reset: 'Відновити пароль' },
			expiry: expiryIn('uk'),
		},
	}
}

/** Each language's words, built on first use: a consumer of this package that sends no IAM e-mail bundles none of them. */
const catalogs: { readonly [L in Locale]: () => IamMailCatalog } = { en: enCatalog, cs: csCatalog, uk: ukCatalog }
const built: { [L in Locale]?: IamMailCatalog } = {}

/** IAM's wording of its e-mails in `locale`. */
export function iamMailCatalog(locale: Locale): IamMailCatalog {
	built[locale] ??= catalogs[locale]()
	return built[locale]
}

/**
 * The language IAM writes an e-mail in: the person's own (the language an invitation names, else the one the mailbox's
 * principal keeps, ADR-0077), else the application's, else the default. An e-mail has no request to ask, so IAM's
 * `chooseLocale` without one comes to the same language; IAM's tests hold the two equal.
 */
export function mailLocale(sources: { readonly person?: Locale | null; readonly app?: Locale | null }): Locale {
	return sources.person ?? sources.app ?? DEFAULT_LOCALE
}

type Placeholders<K extends MessageKind> = { readonly [P in MailPlaceholder<K>]: string }

/** The values an application's template of each message names, beside those every message names. */
const PLACEHOLDER_VALUES: {
	readonly [K in MessageKind]: (values: MessageValues[K]) => Omit<Placeholders<K>, 'displayName' | 'expiry' | 'appUrl'>
} = {
	invitation: ({ recipient, inviterLabel, companyLabel, message, actionUrl }) => ({ recipient, inviterLabel, companyLabel, message, actionUrl }),
	enrollment: ({ recipient, actionUrl }) => ({ recipient, actionUrl }),
	reset: ({ recipient, actionUrl }) => ({ recipient, actionUrl }),
}

/** What an IAM e-mail of one application is rendered with, beside its message's values. */
export interface MailRendering {
	/** The e-mail's language (`mailLocale`). */
	readonly locale: Locale
	/** The application's own template of the message in that language; `null` when it declares none. */
	readonly template: MailTemplate | null
	/** `{{displayName}}`: the application's display name, else its id. */
	readonly displayName: string
	/** `{{appUrl}}`: the application's address with a trailing slash; `null` while no return origin is registered. */
	readonly appUrl: string | null
	/** The longest subject the sender accepts: a filled template's subject gives way at its end. */
	readonly maxSubjectLength: number
}

/**
 * The template IAM renders a `kind` e-mail with: the application's own wording when it declares one in the e-mail's
 * language, else the catalog's. A template the rule no longer admits is the catalog's, and so is one that names
 * `{{appUrl}}` while the application has no registered return origin to build it from.
 */
export function iamMessageTemplate<K extends MessageKind>(kind: K, rendering: MailRendering): (values: MessageValues[K]) => RenderedMessage {
	const catalog = iamMailCatalog(rendering.locale)
	const { template, appUrl } = rendering
	if (template === null) return catalog.messages[kind]
	const html = template.html === undefined ? null : mailHtmlTokens(template.html)
	const namesAppUrl = [template.subject, template.text, template.html ?? ''].some((part) => part.includes('{{appUrl}}'))
	if (mailTemplateProblems(kind, template).length > 0 || (namesAppUrl && appUrl === null)) {
		return catalog.messages[kind]
	}
	const tokens = html !== null && html.ok ? html.tokens : null
	return (values) => {
		const placeholders: Readonly<Record<string, string>> = {
			...PLACEHOLDER_VALUES[kind](values),
			displayName: rendering.displayName,
			expiry: catalog.applicationMail.expiry(values.expiresAt),
			appUrl: appUrl ?? '',
		}
		const message = applicationMessage(template, placeholders, values.actionUrl, catalog.applicationMail.button[kind], rendering.maxSubjectLength)
		return tokens === null ? message : { ...message, html: renderHtml(tokens, placeholders) }
	}
}

/**
 * An application's HTML body, rendered from its tokens and never from its source: each element as the subset writes
 * it, the literal text as the application wrote it (`mailHtmlTokens` admitted no `<` and no bare `&` in it), every value
 * escaped, and each link's `href` the escaped URL it names.
 */
function renderHtml(tokens: readonly MailHtmlToken[], placeholders: Readonly<Record<string, string>>): string {
	return tokens.map((token) => {
		if (token.kind === 'close') return `</${token.name}>`
		if (token.kind === 'open') {
			return token.href === null ? `<${token.name}>` : `<${token.name} href="${escapeHtml(fillMailTemplate(token.href, placeholders))}">`
		}
		return token.text.replaceAll(/\{\{([^{}]*)\}\}/g, (_, name: string) => escapeHtml(placeholders[name] ?? ''))
	}).join('')
}

/**
 * An application's wording filled in: the text as written, the subject on one line, and IAM's own HTML part — the
 * escaped text as paragraphs and IAM's button to the action URL. An application's own HTML body replaces that part.
 */
function applicationMessage(
	template: MailTemplate,
	placeholders: Readonly<Record<string, string>>,
	actionUrl: string,
	button: string,
	maxSubjectLength: number,
): RenderedMessage {
	const text = fillMailTemplate(template.text, placeholders).replaceAll('\r\n', '\n')
	const oneLine = Object.fromEntries(Object.entries(placeholders).map(([name, value]) => [name, value.replaceAll(/\p{Cc}+/gu, ' ')]))
	const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '')
	const html = [
		...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`),
		`<p><a href="${escapeHtml(actionUrl)}">${escapeHtml(button)}</a></p>`,
	].join('')
	return { subject: boundedSubject(fillMailTemplate(template.subject, oneLine), maxSubjectLength), text, html }
}

/** A filled subject the sender accepts: values can expand a short template past its limit, so the end gives way. */
function boundedSubject(subject: string, max: number): string {
	if (subject.length <= max) return subject
	let bounded = ''
	for (const character of subject) {
		if (bounded.length + character.length > max - 1) break
		bounded += character
	}
	return `${bounded}…`
}

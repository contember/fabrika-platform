// What `fabrika app dev` shows a person: the caller picker page, and the toolbar script it injects into every SPA page.
// Both are self-contained (no font, no CDN) and take their colors from `--fd-*` custom properties, light and dark.
// Every value here comes from the seed, the vocabulary or the request, so the page escapes it and the script only ever
// sets `textContent` and `href`.

import type { Locale } from '@fabrika/auth-core'

/** A label beside a caller: a role it holds (with the scope value it holds it in), or that it is external. */
export interface Badge {
	readonly text: string
	readonly tone: 'role' | 'external'
}

/** Who the browser is now, as the picker's header and the toolbar's pill name it. */
export interface CurrentView {
	readonly name: string
	readonly badges: readonly Badge[]
}

export interface PersonaView {
	readonly name: string
	readonly description: string | null
	readonly email: string
	readonly badges: readonly Badge[]
	readonly href: string
	readonly current: boolean
}

/** A role of the vocabulary: chosen with one link when it is app-wide, or with a scope value of its dimension. */
export interface RoleView {
	readonly role: string
	readonly grants: readonly string[]
	readonly external: boolean
	readonly choose:
		| { readonly kind: 'app'; readonly href: string }
		| {
			readonly kind: 'member'
			readonly action: string
			readonly next: string
			readonly dimension: string
			readonly values: readonly { readonly value: string; readonly label: string }[]
		}
}

export interface LinkView {
	readonly title: string
	readonly description: string | null
	readonly href: string
}

export interface MailView {
	readonly to: string
	readonly subject: string
	/** An invitation's state, or `sent` for a message of the dev outbox. */
	readonly status: 'open' | 'accepted' | 'cancelled' | 'expired' | 'sent'
	readonly action: { readonly label: string; readonly href: string } | null
}

export interface DevView {
	readonly locale: Locale
	/** The application's display name, or its id. */
	readonly title: string
	readonly current: CurrentView | null
	readonly personas: readonly PersonaView[]
	readonly roles: readonly RoleView[]
	readonly anonymousHref: string
	readonly links: readonly LinkView[]
	readonly mail: readonly MailView[]
	readonly pickerHref: string
}

interface Strings {
	readonly preview: string
	readonly choose: string
	readonly lede: string
	readonly now: string
	readonly nobody: string
	readonly personas: string
	readonly noPersonas: string
	readonly another: string
	readonly appWide: string
	readonly inScope: (dimension: string) => string
	readonly external: string
	readonly use: string
	readonly scopePlaceholder: (dimension: string) => string
	readonly anonymous: string
	readonly anonymousText: string
	readonly anonymousButton: string
	readonly links: string
	readonly linksText: string
	readonly openLink: string
	readonly mail: string
	readonly mailText: string
	readonly noMail: string
	readonly invitation: (role: string, scope: string) => string
	readonly accept: string
	readonly continueAs: string
	readonly openMessage: string
	readonly status: Readonly<Record<MailView['status'], string>>
	readonly to: string
	readonly picker: string
	readonly close: string
	readonly back: string
}

const STRINGS: Readonly<Record<Locale, Strings>> = {
	en: {
		preview: 'Development preview',
		choose: 'Choose who you are',
		lede: 'Each choice is a caller of the stand-in IAM. The data lives in a throwaway schema and is gone when app dev stops.',
		now: 'You are',
		nobody: 'Nobody (anonymous)',
		personas: 'Personas',
		noPersonas: 'The seed made no personas. Return them from dev/seed.ts.',
		another: 'Another role',
		appWide: 'app-wide',
		inScope: (dimension) => `in one ${dimension}`,
		external: 'external',
		use: 'Use',
		scopePlaceholder: (dimension) => `${dimension} value`,
		anonymous: 'Anonymous',
		anonymousText: 'A page that needs a sign-in brings you back here.',
		anonymousButton: 'Continue anonymously',
		links: 'Link pages',
		linksText: 'Each opens as the holder of a link the application issued.',
		openLink: 'Open as link holder',
		mail: 'Mail',
		mailText: 'The invitations the stand-in IAM would have e-mailed, and what the application sent to the dev outbox.',
		noMail: 'Nothing has been sent yet.',
		invitation: (role, scope) => `Invitation: ${role} in ${scope}`,
		accept: 'Accept invitation',
		continueAs: 'Continue as this person',
		openMessage: 'Open the message',
		status: { open: 'waiting', accepted: 'accepted', cancelled: 'cancelled', expired: 'expired', sent: 'sent' },
		to: 'To',
		picker: 'Choose another caller',
		close: 'Close',
		back: 'Back to the picker',
	},
	cs: {
		preview: 'Vývojový náhled',
		choose: 'Vyberte, kdo jste',
		lede: 'Každá volba je volající zástupného IAM. Data leží v dočasném schématu a zmizí, když app dev skončí.',
		now: 'Jste',
		nobody: 'Nikdo (anonymně)',
		personas: 'Persony',
		noPersonas: 'Seed nevytvořil žádné persony. Vraťte je z dev/seed.ts.',
		another: 'Jiná role',
		appWide: 'v celé aplikaci',
		inScope: (dimension) => `v jedné hodnotě ${dimension}`,
		external: 'externí',
		use: 'Použít',
		scopePlaceholder: (dimension) => `hodnota ${dimension}`,
		anonymous: 'Anonymně',
		anonymousText: 'Stránka, která vyžaduje přihlášení, vás vrátí sem.',
		anonymousButton: 'Pokračovat anonymně',
		links: 'Stránky přes odkaz',
		linksText: 'Každá se otevře jako držitel odkazu, který aplikace vydala.',
		openLink: 'Otevřít jako držitel odkazu',
		mail: 'Pošta',
		mailText: 'Pozvánky, které by zástupný IAM odeslal e-mailem, a co aplikace poslala do vývojové schránky.',
		noMail: 'Zatím nebylo nic odesláno.',
		invitation: (role, scope) => `Pozvánka: ${role} v ${scope}`,
		accept: 'Přijmout pozvánku',
		continueAs: 'Pokračovat jako tato osoba',
		openMessage: 'Otevřít zprávu',
		status: { open: 'čeká', accepted: 'přijata', cancelled: 'zrušena', expired: 'vypršela', sent: 'odesláno' },
		to: 'Komu',
		picker: 'Vybrat jiného volajícího',
		close: 'Zavřít',
		back: 'Zpět na výběr',
	},
}

export const stringsOf = (locale: Locale): Strings => STRINGS[locale]

/** The palette: neutral greys and one accent, redefined for a dark color scheme. */
const TOKENS = `
	--fd-bg: #f6f6f4;
	--fd-surface: #ffffff;
	--fd-surface-2: #f1f1ee;
	--fd-border: #e2e2dd;
	--fd-border-strong: #cdcdc6;
	--fd-text: #1d1d1b;
	--fd-muted: #686862;
	--fd-accent: #3f51b5;
	--fd-accent-soft: #e9ebf8;
	--fd-on-accent: #ffffff;
	--fd-ring: rgba(63, 81, 181, 0.35);
	--fd-warn: #8a5a00;
	--fd-warn-soft: #fbf0db;
	--fd-shadow: 0 1px 2px rgba(20, 20, 18, 0.06), 0 8px 24px rgba(20, 20, 18, 0.1);
	--fd-font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
	--fd-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
`
const DARK_TOKENS = `
	--fd-bg: #131312;
	--fd-surface: #1c1c1b;
	--fd-surface-2: #252524;
	--fd-border: #2f2f2d;
	--fd-border-strong: #42423f;
	--fd-text: #ecece8;
	--fd-muted: #a2a29b;
	--fd-accent: #93a0f2;
	--fd-accent-soft: rgba(147, 160, 242, 0.14);
	--fd-on-accent: #131312;
	--fd-ring: rgba(147, 160, 242, 0.4);
	--fd-warn: #e9bb66;
	--fd-warn-soft: rgba(233, 187, 102, 0.13);
	--fd-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 28px rgba(0, 0, 0, 0.45);
`

const PICKER_CSS = `
:root {${TOKENS}	color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root {${DARK_TOKENS}	}
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--fd-bg); color: var(--fd-text); font: 15px/1.5 var(--fd-font); -webkit-font-smoothing: antialiased; }
a { color: inherit; }
.bar { border-bottom: 1px solid var(--fd-border); background: var(--fd-surface); }
.bar-inner, main { max-width: 960px; margin: 0 auto; padding-left: 16px; padding-right: 16px; }
.bar-inner { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; flex-wrap: wrap; padding-top: 8px; padding-bottom: 8px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fd-accent); flex: none; }
.brand .tag { color: var(--fd-muted); font-weight: 500; }
.now { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--fd-muted); }
.now strong { color: var(--fd-text); font-weight: 600; }
main { padding-top: 40px; padding-bottom: 72px; }
h1 { margin: 0; font-size: 28px; line-height: 1.2; font-weight: 650; letter-spacing: -0.01em; }
.lede { margin: 8px 0 0; color: var(--fd-muted); max-width: 640px; }
section { margin-top: 40px; }
h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fd-muted); }
.hint { margin: 0 0 14px; font-size: 14px; color: var(--fd-muted); }
h2 + .grid, h2 + .rows { margin-top: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.card { display: flex; flex-direction: column; gap: 4px; padding: 16px; border: 1px solid var(--fd-border); border-radius: 12px; background: var(--fd-surface); color: inherit; text-decoration: none; transition: border-color 0.15s, box-shadow 0.15s; }
.card:hover { border-color: var(--fd-border-strong); }
.card[aria-current='true'] { border-color: var(--fd-accent); box-shadow: inset 0 0 0 1px var(--fd-accent); }
.card .name { font-weight: 600; font-size: 16px; }
.card .email { font-size: 13px; color: var(--fd-muted); overflow-wrap: anywhere; }
.card .desc { margin-top: 4px; font-size: 14px; }
.card .cta { margin-top: 10px; font-size: 13px; font-weight: 600; color: var(--fd-accent); }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.badge { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--fd-surface-2); color: var(--fd-muted); border: 1px solid var(--fd-border); white-space: nowrap; }
.badge.role { background: var(--fd-accent-soft); color: var(--fd-accent); border-color: transparent; }
.badge.external { background: var(--fd-warn-soft); color: var(--fd-warn); border-color: transparent; }
.rows { border: 1px solid var(--fd-border); border-radius: 12px; background: var(--fd-surface); overflow: hidden; }
.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; margin: 0; }
.row + .row { border-top: 1px solid var(--fd-border); }
.row .role { font-weight: 600; min-width: 96px; }
.row .meta { flex: 1 1 220px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--fd-muted); }
.row .meta .grants { font-family: var(--fd-mono); font-size: 12px; overflow-wrap: anywhere; }
.row .control { display: flex; gap: 8px; align-items: center; }
.row .meta.stack { flex-direction: column; align-items: flex-start; gap: 2px; }
.actions { margin-top: 24px; }
.subject { font-weight: 600; color: var(--fd-text); font-size: 15px; }
.to { font-size: 13px; color: var(--fd-muted); overflow-wrap: anywhere; }
input { font: inherit; font-size: 14px; height: 34px; padding: 0 10px; width: 200px; border: 1px solid var(--fd-border-strong); border-radius: 8px; background: var(--fd-bg); color: var(--fd-text); }
input::placeholder { color: var(--fd-muted); }
.button { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--fd-accent); background: var(--fd-accent); color: var(--fd-on-accent); font: inherit; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
.button.quiet { background: transparent; color: var(--fd-text); border-color: var(--fd-border-strong); }
.button.quiet:hover { background: var(--fd-surface-2); }
.empty { padding: 16px; border: 1px dashed var(--fd-border-strong); border-radius: 12px; color: var(--fd-muted); font-size: 14px; }
a:focus-visible, button:focus-visible, input:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--fd-ring); border-color: var(--fd-accent); }
@media (max-width: 560px) {
	main { padding-top: 28px; }
	h1 { font-size: 24px; }
	.row .control { flex: 1 1 100%; }
	.row .control input { flex: 1; width: auto; min-width: 0; }
}
`

const escapeHtml = (text: string): string =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const badges = (list: readonly Badge[]): string =>
	list.length === 0
		? ''
		: `<div class="badges">${list.map((badge) => `<span class="badge ${badge.tone}">${escapeHtml(badge.text)}</span>`).join('')}</div>`

function page(view: Pick<DevView, 'locale' | 'title' | 'current'>, heading: string, body: string): string {
	const text = stringsOf(view.locale)
	const now = view.current === null
		? `<span>${escapeHtml(text.now)}:</span> <strong>${escapeHtml(text.nobody)}</strong>`
		: `<span>${escapeHtml(text.now)}:</span> <strong>${escapeHtml(view.current.name)}</strong>${
			view.current.badges.map((badge) => `<span class="badge ${badge.tone}">${escapeHtml(badge.text)}</span>`).join('')
		}`
	return `<!doctype html>
<html lang="${view.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(view.title)} · ${escapeHtml(text.preview)}</title>
<style>${PICKER_CSS}</style>
</head>
<body>
<header class="bar"><div class="bar-inner"><span class="brand"><span class="dot"></span>fabrika app dev <span class="tag">${
		escapeHtml(text.preview)
	}</span></span><span class="now">${now}</span></div></header>
<main>
<h1>${escapeHtml(heading)}</h1>
${body}
</main>
</body>
</html>
`
}

function personaCard(persona: PersonaView): string {
	return `<a class="card" href="${escapeHtml(persona.href)}" aria-current="${persona.current ? 'true' : 'false'}"><span class="name">${
		escapeHtml(persona.name)
	}</span><span class="email">${escapeHtml(persona.email)}</span>${
		persona.description === null ? '' : `<span class="desc">${escapeHtml(persona.description)}</span>`
	}${badges(persona.badges)}</a>`
}

function roleRow(role: RoleView, text: Strings): string {
	const meta = [
		role.choose.kind === 'app' ? text.appWide : text.inScope(role.choose.dimension),
		...(role.external ? [`<span class="badge external">${escapeHtml(text.external)}</span>`] : []),
	]
	const describe = `<span class="role">${escapeHtml(role.role)}</span><span class="meta"><span>${escapeHtml(meta[0] ?? '')}</span>${
		meta.slice(1).join('')
	}<span class="grants">${escapeHtml(role.grants.join(', '))}</span></span>`
	if (role.choose.kind === 'app') {
		return `<div class="row">${describe}<span class="control"><a class="button quiet" href="${escapeHtml(role.choose.href)}">${
			escapeHtml(text.use)
		}</a></span></div>`
	}
	const list = `values-${role.role.replaceAll(/[^A-Za-z0-9_-]/g, '_')}`
	const options = role.choose.values.map((value) => `<option value="${escapeHtml(value.value)}">${escapeHtml(value.label)}</option>`).join('')
	return `<form class="row" method="get" action="${
		escapeHtml(role.choose.action)
	}">${describe}<span class="control"><input type="hidden" name="role" value="${escapeHtml(role.role)}"><input type="hidden" name="next" value="${
		escapeHtml(role.choose.next)
	}"><input name="scope" required maxlength="200" list="${list}" aria-label="${
		escapeHtml(text.scopePlaceholder(role.choose.dimension))
	}" placeholder="${
		escapeHtml(text.scopePlaceholder(role.choose.dimension))
	}"><datalist id="${list}">${options}</datalist><button class="button quiet" type="submit">${escapeHtml(text.use)}</button></span></form>`
}

function mailRows(mail: readonly MailView[], text: Strings): string {
	if (mail.length === 0) return `<div class="empty">${escapeHtml(text.noMail)}</div>`
	return `<div class="rows">${
		mail.map((item) =>
			`<div class="row"><span class="meta stack"><span class="subject">${escapeHtml(item.subject)}</span><span class="to">${escapeHtml(text.to)}: ${
				escapeHtml(item.to)
			}</span></span><span class="badge">${escapeHtml(text.status[item.status])}</span>${
				item.action === null
					? ''
					: `<span class="control"><a class="button quiet" href="${escapeHtml(item.action.href)}">${escapeHtml(item.action.label)}</a></span>`
			}</div>`
		).join('')
	}</div>`
}

/** The picker: the personas, another role, anonymous, the link pages, and the mail IAM sent. */
export function pickerPage(view: DevView): string {
	const text = stringsOf(view.locale)
	const personas = view.personas.length === 0
		? `<div class="empty">${escapeHtml(text.noPersonas)}</div>`
		: `<div class="grid">${view.personas.map(personaCard).join('')}</div>`
	const links = view.links.length === 0
		? ''
		: `<section aria-labelledby="links"><h2 id="links">${escapeHtml(text.links)}</h2><p class="hint">${
			escapeHtml(text.linksText)
		}</p><div class="grid">${
			view.links.map((link) =>
				`<a class="card" href="${escapeHtml(link.href)}"><span class="name">${escapeHtml(link.title)}</span>${
					link.description === null ? '' : `<span class="desc">${escapeHtml(link.description)}</span>`
				}<span class="cta">${escapeHtml(text.openLink)} →</span></a>`
			).join('')
		}</div></section>`
	const body = `<p class="lede">${escapeHtml(text.lede)}</p>
<section aria-labelledby="personas"><h2 id="personas">${escapeHtml(text.personas)}</h2>${personas}</section>
<section aria-labelledby="roles"><h2 id="roles">${escapeHtml(text.another)}</h2><div class="rows">${
		view.roles.map((role) => roleRow(role, text)).join('')
	}</div></section>
<section aria-labelledby="anonymous"><h2 id="anonymous">${escapeHtml(text.anonymous)}</h2><p class="hint">${
		escapeHtml(text.anonymousText)
	}</p><a class="button quiet" href="${escapeHtml(view.anonymousHref)}">${escapeHtml(text.anonymousButton)}</a></section>
${links}
<section aria-labelledby="mail"><h2 id="mail">${escapeHtml(text.mail)}</h2><p class="hint">${escapeHtml(text.mailText)}</p>${
		mailRows(view.mail, text)
	}</section>`
	return page(view, `${view.title}: ${text.choose.toLowerCase()}`, body)
}

/** A refusal of a dev route, with the way back to the picker. */
export function noticePage(view: Pick<DevView, 'locale' | 'title' | 'current' | 'pickerHref'>, heading: string, message: string): string {
	const text = stringsOf(view.locale)
	return page(
		view,
		heading,
		`<p class="lede">${escapeHtml(message)}</p><p class="actions"><a class="button" href="${escapeHtml(view.pickerHref)}">${
			escapeHtml(text.back)
		}</a></p>`,
	)
}

/** What the toolbar renders: its labels and the view, with every caller already put into words. */
export function toolbarState(view: DevView): unknown {
	const text = stringsOf(view.locale)
	const detail = (list: readonly Badge[]) => list.map((badge) => badge.text).join(', ')
	return {
		labels: {
			now: text.now,
			personas: text.personas,
			links: text.links,
			mail: text.mail,
			noMail: text.noMail,
			picker: text.picker,
			close: text.close,
			preview: text.preview,
		},
		title: view.title,
		current: view.current === null ? { name: text.nobody, detail: '' } : { name: view.current.name, detail: detail(view.current.badges) },
		personas: view.personas.map((persona) => ({ name: persona.name, detail: detail(persona.badges), href: persona.href, current: persona.current })),
		links: view.links.map((link) => ({ title: link.title, detail: link.description ?? '', href: link.href })),
		mail: view.mail.map((item) => ({ subject: item.subject, detail: `${text.to}: ${item.to} · ${text.status[item.status]}`, action: item.action })),
		picker: view.pickerHref,
	}
}

const TOOLBAR_CSS = `
:host { all: initial; }
.fd { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font: 13px/1.4 var(--fd-font); color: var(--fd-text); text-align: left; }
.pill { display: inline-flex; align-items: center; gap: 8px; max-width: min(360px, calc(100vw - 32px)); height: 36px; padding: 0 14px 0 12px; border-radius: 999px; border: 1px solid var(--fd-border); background: var(--fd-surface); color: var(--fd-text); box-shadow: var(--fd-shadow); font: inherit; cursor: pointer; }
.pill:hover { border-color: var(--fd-border-strong); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fd-accent); flex: none; }
.who { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.what { color: var(--fd-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel { position: absolute; right: 0; bottom: 46px; width: 340px; max-width: calc(100vw - 32px); max-height: min(72vh, 600px); overflow: auto; background: var(--fd-surface); border: 1px solid var(--fd-border); border-radius: 14px; box-shadow: var(--fd-shadow); }
.panel[hidden] { display: none; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--fd-border); }
.head .title { font-weight: 600; font-size: 14px; }
.head .tag { display: block; font-size: 12px; color: var(--fd-muted); }
.close { width: 28px; height: 28px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--fd-muted); font: inherit; font-size: 18px; line-height: 1; cursor: pointer; }
.close:hover { background: var(--fd-surface-2); color: var(--fd-text); }
.section { padding: 10px 8px; }
.section + .section { border-top: 1px solid var(--fd-border); }
.label { padding: 2px 8px 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fd-muted); }
.item { display: flex; flex-direction: column; gap: 1px; padding: 8px; border-radius: 8px; color: var(--fd-text); text-decoration: none; }
a.item:hover { background: var(--fd-surface-2); }
.item[aria-current='true'] { background: var(--fd-accent-soft); }
.item .name { font-weight: 600; }
.item[aria-current='true'] .name { color: var(--fd-accent); }
.item .sub { font-size: 12px; color: var(--fd-muted); overflow-wrap: anywhere; }
.item .act { margin-top: 4px; font-size: 12px; font-weight: 600; color: var(--fd-accent); }
.empty { padding: 4px 8px 6px; color: var(--fd-muted); }
.more { display: block; margin-top: 2px; padding: 8px; border-radius: 8px; color: var(--fd-accent); font-weight: 600; text-decoration: none; }
.more:hover { background: var(--fd-surface-2); }
a:focus-visible, button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--fd-ring); }
`

/** The toolbar: a pill in the bottom corner, in a shadow root so neither the page's styles nor its layout meet it. */
export function toolbarScript(statePath: string): string {
	const css = `:host {${TOKENS}}\n@media (prefers-color-scheme: dark) { :host {${DARK_TOKENS}} }\n${TOOLBAR_CSS}`
	return `// fabrika app dev: the dev toolbar. Served by app dev only, never by the kit's tests or a deploy.
(() => {
	'use strict'
	if (document.querySelector('fabrika-dev-toolbar') !== null) return
	const CSS = ${JSON.stringify(css)}
	const STATE = ${JSON.stringify(statePath)}

	const node = (tag, className, text) => {
		const element = document.createElement(tag)
		if (className) element.className = className
		if (text !== undefined) element.textContent = text
		return element
	}
	const link = (href, className) => {
		const element = node('a', className)
		element.href = href
		return element
	}
	const section = (label) => {
		const element = node('div', 'section')
		element.append(node('div', 'label', label))
		return element
	}
	const entry = (href, name, sub, current) => {
		const element = href === null ? node('div', 'item') : link(href, 'item')
		element.append(node('span', 'name', name))
		if (sub) element.append(node('span', 'sub', sub))
		if (current) element.setAttribute('aria-current', 'true')
		return element
	}

	const mount = (state) => {
		const host = document.createElement('fabrika-dev-toolbar')
		const root = host.attachShadow({ mode: 'open' })
		const style = document.createElement('style')
		style.textContent = CSS
		const frame = node('div', 'fd')
		const pill = node('button', 'pill')
		pill.type = 'button'
		pill.setAttribute('aria-haspopup', 'true')
		pill.setAttribute('aria-expanded', 'false')
		pill.setAttribute('aria-label', 'fabrika app dev · ' + state.labels.now + ': ' + state.current.name)
		pill.append(node('span', 'dot'), node('span', 'who', state.current.name))
		if (state.current.detail) pill.append(node('span', 'what', state.current.detail))

		const panel = node('div', 'panel')
		panel.hidden = true
		panel.id = 'fabrika-dev-panel'
		panel.setAttribute('role', 'dialog')
		panel.setAttribute('aria-label', 'fabrika app dev')
		pill.setAttribute('aria-controls', panel.id)
		const head = node('div', 'head')
		const heading = node('div')
		heading.append(node('span', 'title', state.title), node('span', 'tag', 'fabrika app dev · ' + state.labels.preview))
		const close = node('button', 'close', '×')
		close.type = 'button'
		close.setAttribute('aria-label', state.labels.close)
		head.append(heading, close)
		panel.append(head)

		const personas = section(state.labels.personas)
		for (const persona of state.personas) personas.append(entry(persona.href, persona.name, persona.detail, persona.current))
		const more = link(state.picker, 'more')
		more.textContent = state.labels.picker + ' →'
		personas.append(more)
		panel.append(personas)

		if (state.links.length > 0) {
			const links = section(state.labels.links)
			for (const item of state.links) links.append(entry(item.href, item.title, item.detail, false))
			panel.append(links)
		}

		const mail = section(state.labels.mail)
		if (state.mail.length === 0) mail.append(node('div', 'empty', state.labels.noMail))
		for (const item of state.mail) {
			const element = entry(item.action === null ? null : item.action.href, item.subject, item.detail, false)
			if (item.action !== null) element.append(node('span', 'act', item.action.label + ' →'))
			mail.append(element)
		}
		panel.append(mail)

		const open = (opened) => {
			panel.hidden = !opened
			pill.setAttribute('aria-expanded', String(opened))
		}
		pill.addEventListener('click', () => open(panel.hidden))
		close.addEventListener('click', () => {
			open(false)
			pill.focus()
		})
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && !panel.hidden) {
				open(false)
				pill.focus()
			}
		})
		document.addEventListener('pointerdown', (event) => {
			if (!panel.hidden && !event.composedPath().includes(host)) open(false)
		})
		frame.append(panel, pill)
		root.append(style, frame)
		document.documentElement.append(host)
	}

	const start = async () => {
		const next = location.pathname + location.search
		const response = await fetch(STATE + '?next=' + encodeURIComponent(next), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
		if (response.ok) mount(await response.json())
	}
	const run = () => {
		start().catch(() => {})
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run)
	else run()
})()
`
}

/** `html` with the toolbar's script tag before its `</body>`, or at its end when it has none. */
export function withToolbar(html: string, scriptPath: string): string {
	const tag = `<script src="${escapeHtml(scriptPath)}" defer></script>`
	const at = html.toLowerCase().lastIndexOf('</body>')
	return at < 0 ? `${html}${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`
}

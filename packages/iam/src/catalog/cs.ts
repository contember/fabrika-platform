import { escapeHtml } from '../html'
import type { Catalog, RenderedMessage } from './index'
import { quotedNote } from './quoted-note'

export const cs: Catalog = {
	pages: {
		runsOn: 'Běží na platformě',
		showPassword: 'Zobrazit',
		hidePassword: 'Skrýt',
		email: 'E-mail',
		signIn: {
			title: (appName) => (appName === null ? 'Přihlášení' : `Přihlášení do aplikace ${appName}`),
			password: 'Heslo',
			submit: 'Přihlásit se',
			forgot: 'Zapomenuté heslo?',
			singleSignOn: 'Pokračovat přes jednotné přihlášení',
			invalidCredentials: 'Neplatný e-mail nebo heslo.',
		},
		chooseAccount: {
			title: (appName) => (appName === null ? 'Pokračovat do aplikace' : `Pokračovat do aplikace ${appName}`),
			signedInAs: 'Jste přihlášeni jako',
			continueAs: (label) => `Pokračovat jako ${label}`,
			another: 'Použít jiný účet',
			anotherNote: 'Přechodem na jiný účet se tento prohlížeč odhlásí ze všech aplikací, do kterých je tímto účtem přihlášen.',
		},
		forgot: {
			title: 'Obnovení hesla',
			intro: (appName) =>
				appName === null
					? 'Zadejte adresu, kterou se přihlašujete.'
					: `Zadejte adresu, kterou se přihlašujete do aplikace ${appName}.`,
			submit: 'Pokračovat',
			sentTitle: 'Žádost přijata',
			sentText: 'Pokud účet může používat přihlášení heslem a e-mail se podaří doručit, přijde vám jednorázový odkaz.',
			back: 'Zpět na přihlášení',
		},
		setPassword: {
			title: (purpose) => (purpose === 'enrollment' ? 'Nastavte si heslo' : 'Obnovte si heslo'),
			rule: (min, max) => `Použijte ${min}–${max} znaků. Dlouhé fráze jsou vítány.`,
			shared: (appName) =>
				appName === null
					? 'Heslo patří k vašemu účtu v této přihlašovací službě a platí pro všechny aplikace, které ji používají.'
					: `Heslo patří k vašemu účtu v této přihlašovací službě a platí pro všechny aplikace, které ji používají, nejen pro aplikaci ${appName}.`,
			newPassword: 'Nové heslo',
			problem: (problem, min, max) => {
				switch (problem) {
					case 'too_short':
						return `Použijte alespoň ${min} ${min >= 2 && min <= 4 ? 'znaky' : 'znaků'}.`
					case 'too_long':
						return `Použijte nejvýše ${max} znaků.`
					case 'guessable':
						return 'Zvolte heslo, které nevychází z údajů vašeho účtu a není běžně používané.'
				}
			},
		},
		failure: {
			title: 'Chyba přihlášení',
			text: (failure) => {
				switch (failure.kind) {
					case 'no_return_address':
						return 'Pro tuto aplikaci nebyla zadána návratová adresa.'
					case 'no_handoff_proof':
						return 'Pro tuto aplikaci chybí platný doklad předání z prohlížeče.'
					case 'unregistered_origin':
						return `${failure.origin} není registrovaná návratová adresa této aplikace.`
					case 'password_disabled':
						return 'Přihlášení heslem je vypnuté.'
					case 'oidc_disabled':
						return 'Jednotné přihlášení je vypnuté.'
					case 'cross_origin':
						return 'Neplatný původ požadavku.'
					case 'malformed_form':
						return 'Neplatný formulář.'
					case 'login_unavailable':
						return 'Přihlášení teď není k dispozici. Zkuste to později.'
					case 'logout_unavailable':
						return 'Odhlášení teď není k dispozici. Zkuste to později.'
					case 'oidc_invalid_state':
						return 'Pokus o jednotné přihlášení je neplatný nebo vypršel. Přihlaste se znovu.'
					case 'oidc_exchange_failed':
						return 'Poskytovatel identity přihlášení nedokončil.'
					case 'oidc_invalid_id_token':
						return 'Poskytovatel identity vrátil neplatnou identitu.'
					case 'not_admitted':
						return 'Tento účet se zde nemůže přihlásit.'
					case 'login_refused':
						return `Přihlášení bylo odmítnuto (${failure.reason}).`
				}
			},
		},
		invalidLink: {
			title: 'Odkaz není k dispozici',
			text: 'Tento odkaz je neplatný, vypršel, nebo už byl použit.',
			requestNew: 'Vyžádat nový odkaz',
		},
		logout: {
			title: 'Odhlášení',
			text: 'Tím ukončíte přihlášení ve všech aplikacích, do kterých jste přihlášeni.',
			submit: 'Odhlásit se',
		},
		invitation: {
			title: 'Přijetí pozvánky',
			text: 'Přijměte pozvánku. Máte-li zde účet, nejprve se přihlaste pozvanou adresou. Pokud ho nemáte, v dalším kroku si zvolíte heslo.',
			submit: 'Přijmout pozvánku',
			createTitle: 'Zvolte si heslo',
			createText: (address) => `Váš účet se přihlašuje adresou ${address} a heslem, které si zde zvolíte. Zvolením hesla pozvánku přijmete.`,
			createSubmit: 'Nastavit heslo a přijmout',
			otherAccountTitle: 'Jste přihlášeni jiným účtem',
			otherAccountText: (address) =>
				`Tato pozvánka zakládá nový účet pro adresu ${address} a tento prohlížeč je přihlášen jiným účtem. Nejprve se odhlaste, nebo otevřete odkaz z pozvánky v jiném profilu prohlížeče.`,
			signOut: 'Odhlásit se',
			signInFirstTitle: 'Nejprve se přihlaste',
			signInFirstText: 'Přihlaste se pozvanou adresou a potom znovu otevřete odkaz z pozvánky.',
			signIn: 'Přihlásit se',
			unavailableTitle: 'Pozvánka není k dispozici',
			accountCannotAccept: 'Tento účet nemůže přijímat pozvánky.',
			wrongAddressTitle: 'Pozvánka pro jinou adresu',
			wrongAddressText: 'Jste přihlášeni adresou, na kterou tato pozvánka nebyla poslána. Přihlaste se pozvanou adresou.',
			inviterCannotGrant: 'Osoba, která pozvánku poslala, už tuto roli nemůže udělit. Požádejte o novou pozvánku.',
			roleNotEligible: 'Tento účet nemůže mít roli, kterou pozvánka dává. Obraťte se na toho, kdo ji poslal.',
			acceptedTitle: 'Pozvánka přijata',
			acceptedText: ({ role, scope, appName }) => `V aplikaci ${appName} teď máte roli ${role} (${scope}).`,
			invalidTitle: 'Odkaz není k dispozici',
			invalidText: 'Tato pozvánka je neplatná, vypršela, byla zrušena, nebo už byla použita.',
		},
	},
	messages: {
		invitation: ({ appName, role, scope, inviterLabel, companyLabel, message, actionUrl }) => {
			const what = `do aplikace ${appName} s rolí ${role} (${scope})${companyLabel === '' ? '' : ` za ${companyLabel}`}`
			const note = message === '' ? null : { intro: `${inviterLabel} píše:`, message }
			const accept =
				'Pozvánku přijmete tímto jednorázovým odkazem. Máte-li zde účet, nejprve se přihlaste touto adresou; pokud ho nemáte, zvolíte si heslo.'
			return {
				subject: `Pozvánka do aplikace ${appName}`,
				text: [`Dostali jste pozvánku ${what}.`, ...(note === null ? [] : [note.intro, note.message]), accept, actionUrl, IGNORE_INVITATION].join(
					'\n\n',
				),
				html: `<p>Dostali jste pozvánku ${escapeHtml(what)}.</p>${quotedNote(note)}<p>${escapeHtml(accept)}</p><p><a href="${
					escapeHtml(actionUrl)
				}">Přijmout pozvánku</a></p><p>${escapeHtml(IGNORE_INVITATION)}</p>`,
			}
		},
		enrollment: ({ appName, actionUrl }) =>
			passwordMessage(
				appName === null ? 'Nastavení hesla' : `Nastavení hesla pro aplikaci ${appName}`,
				'si nastavíte heslo',
				actionUrl,
			),
		reset: ({ appName, actionUrl }) =>
			passwordMessage(
				appName === null ? 'Obnovení hesla' : `Obnovení hesla pro aplikaci ${appName}`,
				'si obnovíte heslo',
				actionUrl,
			),
	},
	applicationMail: {
		button: { invitation: 'Přijmout pozvánku', enrollment: 'Nastavit heslo', reset: 'Obnovit heslo' },
		expiry: (expiresAt) => `${expiryFormat.format(new Date(expiresAt * 1000))} UTC`,
	},
}

const IGNORE_INVITATION = 'Pokud jste pozvánku nečekali, můžete tento e-mail ignorovat.'

const expiryFormat = new Intl.DateTimeFormat('cs', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })

function passwordMessage(subject: string, action: string, actionUrl: string): RenderedMessage {
	return {
		subject,
		text: `Tímto jednorázovým odkazem ${action}:\n\n${actionUrl}\n\nPokud jste o to nežádali, můžete tento e-mail ignorovat.`,
		html: `<p>Tímto jednorázovým odkazem ${escapeHtml(action)}:</p><p><a href="${escapeHtml(actionUrl)}">${
			escapeHtml(subject)
		}</a></p><p>Pokud jste o to nežádali, můžete tento e-mail ignorovat.</p>`,
	}
}

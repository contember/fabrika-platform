import { iamMailCatalog } from '@fabrika/auth-core'
import type { Catalog } from './index'

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
					case 'terminal_enrolment_not_allowed':
						return 'Přihlaste se účtem, který smí registrovat terminály.'
					case 'terminal_enrolment_unavailable':
						return 'Registrace teď není k dispozici. Zkuste to později.'
					case 'terminal_completion_refused':
						return 'Toto přihlášení vypršelo nebo už bylo použito. Identifikujte se znovu.'
					case 'second_factor_expired':
						return 'Přihlášení vypršelo dřív, než jste zadali kód. Přihlaste se znovu.'
					case 'second_factor_not_allowed':
						return 'Dvoufázové přihlášení si nastavíte po přihlášení účtem administrátora.'
					case 'second_factor_unavailable':
						return 'Dvoufázové přihlášení teď není k dispozici. Zkuste to později.'
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
		terminal: {
			enrolTitle: 'Registrovat tento počítač jako terminál',
			enrolText:
				'Lidé se na tomto počítači budou přihlašovat přes aplikace, pro které je nastavený. Registrace vás v tomto prohlížeči odhlásí, aby terminál nikdy nezůstal přihlášený pod vaším účtem.',
			label: 'Název terminálu',
			labelProblem: (max) => `Použijte 1–${max} znaků.`,
			submit: 'Registrovat a odhlásit',
			enrolledTitle: 'Terminál je zaregistrovaný',
			enrolledText: (label) => `Tento prohlížeč je teď terminál ${label}. Jste odhlášeni. Které aplikace obsluhuje, nastaví administrátor.`,
		},
		secondFactor: {
			challengeTitle: 'Dvoufázové přihlášení',
			challengeText: 'Zadejte šestimístný kód z ověřovací aplikace, nebo jeden ze svých záložních kódů.',
			codeLabel: 'Kód',
			submit: 'Ověřit',
			invalidCode: 'Tento kód neplatí. Zadejte aktuální kód, nebo záložní kód, který jste ještě nepoužili.',
			throttled: 'Příliš mnoho chybných kódů. Počkejte 15 minut a zkuste to znovu.',
			appCodesUnavailable: 'Kódy z ověřovací aplikace tu teď nejde ověřit. Použijte záložní kód, nebo se obraťte na administrátora.',
			startOver: 'Přihlásit se znovu',
			enrolTitle: 'Nastavit dvoufázové přihlášení',
			enrolText:
				'Po hesle nebo jednotném přihlášení si každé přihlášení k tomuto účtu vyžádá kód z ověřovací aplikace ve vašem telefonu. Dostanete také záložní kódy pro chvíle, kdy telefon nemáte po ruce.',
			start: 'Nastavit ověřovací aplikaci',
			scanText: 'Naskenujte QR kód ověřovací aplikací, nebo do ní opište klíč. Pak zadejte šestimístný kód, který zobrazí.',
			secretLabel: 'Klíč',
			confirmLabel: 'Kód z aplikace',
			confirm: 'Zapnout dvoufázové přihlášení',
			enrolledTitle: 'Dvoufázové přihlášení je zapnuté',
			enrolledText: (enrolledOn, left) =>
				`Od ${enrolledOn} si každé přihlášení k tomuto účtu vyžádá kód. Zbývající záložní kódy: ${left}. Při přechodu na nový telefon požádejte administrátora o zrušení ověřovací aplikace.`,
			recoveryTitle: 'Uložte si záložní kódy',
			recoveryText: 'Každý kód vás jednou přihlásí, když telefon nemáte po ruce. Zobrazují se jen teď: uložte je na bezpečné místo mimo telefon.',
			continue: 'Pokračovat',
			unavailableTitle: 'Dvoufázové přihlášení není k dispozici',
			unavailableText: 'Tato instalace zatím neumí ukládat klíče ověřovacích aplikací. Požádejte jejího provozovatele o nastavení.',
		},
		account: {
			title: 'Váš účet',
			connectionsTitle: 'Připojení agenti a zařízení',
			connectionsText: 'Každé z nich jedná za vás, s vašimi oprávněními, dokud neskončí. Odvolání ho zastaví do pěti minut; co už změnilo, zůstává.',
			none: 'K vašemu účtu není nic připojeno.',
			agent: (label) => (label === null ? 'Agent, který neuvedl jméno' : `Agent „${label}“`),
			agentWords: 'Jméno jsou slova samotného agenta; nic ho neověřuje.',
			commandLine: 'Příkazová řádka fabrika',
			client: (clientId) => `Klient ${clientId}`,
			reaches: 'Přístup k',
			mode: (mode) => (mode === 'read' ? 'Čte, co můžete číst vy, a nic nemění' : 'Jedná za vás, včetně změn'),
			scopes: 'Rozsahy',
			allowed: 'Povoleno',
			ends: 'Končí',
			confirmedWith: (passkey) => `Potvrzeno přístupovým klíčem „${passkey}“`,
			confirmedWithRemoved: 'Potvrzeno přístupovým klíčem, který jste mezitím odebrali',
			confirmedWithUnrecorded: 'Potvrzeno přístupovým klíčem',
			revoke: 'Odvolat',
			revoked: 'Přístup odvolán. Přestane fungovat do pěti minut.',
			alreadyEnded: 'Tento přístup už skončil.',
			more: (shown) => `Zobrazeno ${shown} nejnovějších.`,
			onThisPage: 'Na této stránce',
			holder: 'Agent nebo zařízení',
			lastActive: 'Naposledy aktivní',
			notRenewed: 'Od schválení ne',
			lastActiveText: 'Naposledy aktivní je chvíle posledního obnovení přístupu; během používání se obnovuje každých pět minut.',
			details: 'Podrobnosti',
			endpoints: 'Adresy, které může volat',
			cliPreset: (preset, app) => {
				const target = app ?? 'každou aplikaci, kterou smíte'
				switch (preset) {
					case 'read':
						return `Čte ${target} a nic nemění`
					case 'deploy':
						return `Čte a nasazuje ${target}`
					case 'operate':
						return `Nasazuje ${target} a spravuje její tajné hodnoty a nastavení`
					case 'create':
						return 'Registruje aplikace a mění nebo maže ty, které smíte spravovat'
				}
			},
			revokeLabel: (holder, reaches, allowed) => `Odvolat ${holder} – ${reaches}, povoleno ${allowed}`,
			revokeTitle: 'Odvolat tento přístup?',
			revokeConfirm: (holder, reaches) => `${holder}: přístup k ${reaches} skončí do pěti minut. Co už bylo změněno, zůstává.`,
			cancel: 'Zrušit',
		},
		passkeys: {
			title: 'Přístupové klíče',
			text: 'Přístupový klíč potvrzuje citlivý krok, například rozhodnutí o schválení v konzoli. Nepřihlašuje vás.',
			none: 'Nemáte žádný přístupový klíč.',
			added: 'Přidán',
			lastUsed: 'Naposledy použit',
			neverUsed: 'Zatím nepoužit',
			remove: 'Odebrat',
			removeLabel: (label) => `Odebrat přístupový klíč „${label}“`,
			addTitle: 'Přidat přístupový klíč',
			label: 'Název',
			labelHint: 'Například zařízení nebo správce hesel, který ho uchovává.',
			add: 'Přidat přístupový klíč',
			addedNotice: 'Přístupový klíč byl přidán.',
			removedNotice: 'Přístupový klíč byl odebrán.',
			refusedNotice: 'Ověření přístupovým klíčem neprošlo nebo vypršelo. Nic se nezměnilo; zkuste to znovu.',
			busyNotice: 'Otevřených ověření je příliš mnoho. Zkuste to za pár minut.',
			duplicateNotice: 'Tento přístupový klíč už je zaregistrovaný.',
			limitNotice: 'Máte nejvíc přístupových klíčů, kolik jeden člověk může mít. Nejdřív některý odeberte.',
			labelNotice: 'Pojmenujte přístupový klíč.',
			confirmTitle: 'Potvrďte přístupovým klíčem',
			confirmAddText: 'Přístupový klíč už máte, takže přidání dalšího vyžaduje ověření tím, který máte.',
			confirmRemoveText: (label) => `Odebrání přístupového klíče „${label}“ vyžaduje ověření některým z vašich přístupových klíčů.`,
			createTitle: 'Vytvořit přístupový klíč',
			createText: (label) => `Prohlížeč požádá vaše zařízení nebo správce hesel o vytvoření přístupového klíče „${label}“.`,
			continue: 'Pokračovat s přístupovým klíčem',
			unsupported: 'Tento prohlížeč přístupové klíče nepodporuje.',
			failed: 'Ověření přístupovým klíčem nebylo dokončeno. Zkuste to znovu.',
			back: 'Zpět na váš účet',
			stepUpTitle: 'Potvrďte přístupovým klíčem',
			stepUpText:
				'Konzole žádá o potvrzení kroku některým z vašich přístupových klíčů: rozhodnutí o schválení, nebo změnu ochrany prostředí. Potvrďte jen tehdy, pokud jste ho právě zahájili.',
			stepUpDone: 'Potvrzeno. Zavřete tuto kartu a pokračujte v konzoli.',
			stepUpGone: 'Toto ověření vypršelo nebo už bylo použito. Zavřete kartu a začněte znovu v konzoli.',
			stepUpRefused: 'Přístupový klíč nebyl přijat. Zavřete kartu a začněte znovu v konzoli.',
		},
		invitation: {
			title: 'Přijetí pozvánky',
			text: 'Přijměte pozvánku. V dalším kroku se přihlásíte pozvanou adresou, nebo si zvolíte heslo, pokud pozvánka zakládá nový účet.',
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
			noAccountTitle: 'Pro tuto adresu tu není účet',
			noAccountText: (address) =>
				`Pro adresu ${address} tu není účet a tato pozvánka ho nezakládá. Požádejte toho, kdo vás pozval, aby vám pro tuto adresu zřídil účet, a potom znovu otevřete odkaz z pozvánky.`,
			unavailableTitle: 'Pozvánka není k dispozici',
			accountCannotAccept: 'Tento účet nemůže přijímat pozvánky.',
			wrongAddressTitle: 'Pozvánka pro jinou adresu',
			wrongAddressText: 'Jste přihlášeni adresou, na kterou tato pozvánka nebyla poslána. Přihlaste se pozvanou adresou.',
			inviterCannotGrant: 'Osoba, která pozvánku poslala, už tuto roli nemůže udělit. Požádejte o novou pozvánku.',
			roleNotEligible: 'Tento účet nemůže mít roli, kterou pozvánka dává. Obraťte se na toho, kdo ji poslal.',
			acceptedTitle: 'Pozvánka přijata',
			acceptedText: ({ role, scope, appName }) => `V aplikaci ${appName} teď máte roli ${role} (${scope}).`,
			invalidTitle: 'Odkaz není k dispozici',
			invalidText:
				'Tato pozvánka je neplatná, vypršela, byla zrušena, nebo už byla použita. Pokud jste ji ještě nepřijali, požádejte toho, kdo vás pozval, aby ji poslal znovu.',
		},
	},
	...iamMailCatalog('cs'),
}

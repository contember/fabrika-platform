import { escapeHtml } from '../html'
import type { Catalog, RenderedMessage } from './index'
import { quotedNote } from './quoted-note'

export const uk: Catalog = {
	pages: {
		runsOn: 'Працює на платформі',
		showPassword: 'Показати',
		hidePassword: 'Сховати',
		email: 'Електронна пошта',
		signIn: {
			title: (appName) => (appName === null ? 'Вхід' : `Вхід до застосунку ${appName}`),
			password: 'Пароль',
			submit: 'Увійти',
			forgot: 'Забули пароль?',
			singleSignOn: 'Продовжити через єдиний вхід',
			invalidCredentials: 'Неправильна електронна адреса або пароль.',
		},
		chooseAccount: {
			title: (appName) => (appName === null ? 'Перехід до застосунку' : `Перехід до застосунку ${appName}`),
			signedInAs: 'Ви ввійшли як',
			continueAs: (label) => `Продовжити як ${label}`,
			another: 'Використати інший обліковий запис',
			anotherNote: 'Якщо перейти на інший обліковий запис, цей браузер вийде з усіх застосунків, у які ввійшов із цим обліковим записом.',
		},
		forgot: {
			title: 'Відновлення пароля',
			intro: (appName) =>
				appName === null
					? 'Вкажіть електронну адресу, з якою ви входите.'
					: `Вкажіть електронну адресу, з якою ви входите до застосунку ${appName}.`,
			submit: 'Продовжити',
			sentTitle: 'Запит отримано',
			sentText: 'Якщо цей обліковий запис може входити за паролем і лист вдасться доставити, ви отримаєте одноразове посилання.',
			back: 'Повернутися до входу',
		},
		setPassword: {
			title: (purpose) => (purpose === 'enrollment' ? 'Створіть пароль' : 'Відновіть пароль'),
			rule: (min, max) => `Використайте ${min}–${max} символів. Довга парольна фраза — гарний вибір.`,
			shared: (appName) =>
				appName === null
					? 'Пароль належить до вашого облікового запису в цій службі входу і діє в усіх застосунках, які її використовують.'
					: `Пароль належить до вашого облікового запису в цій службі входу і діє в усіх застосунках, які її використовують, а не лише в застосунку ${appName}.`,
			newPassword: 'Новий пароль',
			problem: (problem, min, max) => {
				switch (problem) {
					case 'too_short':
						return `Пароль має містити щонайменше ${min} ${characters(min)}.`
					case 'too_long':
						return `Пароль може містити щонайбільше ${max} ${characters(max)}.`
					case 'guessable':
						return 'Виберіть пароль, який не походить від даних вашого облікового запису і не належить до поширених.'
				}
			},
		},
		failure: {
			title: 'Помилка входу',
			text: (failure) => {
				switch (failure.kind) {
					case 'no_return_address':
						return 'Для цього застосунку не вказано адресу повернення.'
					case 'no_handoff_proof':
						return 'Для цього застосунку браузер не надав дійсного підтвердження передачі входу.'
					case 'unregistered_origin':
						return `${failure.origin} не є зареєстрованою адресою повернення цього застосунку.`
					case 'password_disabled':
						return 'Вхід за паролем вимкнено.'
					case 'oidc_disabled':
						return 'Єдиний вхід вимкнено.'
					case 'cross_origin':
						return 'Недійсне джерело запиту.'
					case 'malformed_form':
						return 'Недійсна форма.'
					case 'login_unavailable':
						return 'Вхід зараз недоступний. Спробуйте пізніше.'
					case 'logout_unavailable':
						return 'Вихід зараз недоступний. Спробуйте пізніше.'
					case 'oidc_invalid_state':
						return 'Спроба єдиного входу недійсна або застаріла. Увійдіть ще раз.'
					case 'oidc_exchange_failed':
						return 'Постачальник ідентифікації не завершив вхід.'
					case 'oidc_invalid_id_token':
						return 'Постачальник ідентифікації повернув недійсні ідентифікаційні дані.'
					case 'not_admitted':
						return 'З цим обліковим записом тут увійти не можна.'
					case 'login_refused':
						return `Вхід відхилено (${failure.reason}).`
					case 'terminal_enrolment_not_allowed':
						return 'Увійдіть з обліковим записом, якому дозволено реєструвати термінали.'
					case 'terminal_enrolment_unavailable':
						return 'Реєстрація зараз недоступна. Спробуйте пізніше.'
					case 'terminal_completion_refused':
						return 'Цей вхід застарів або вже використаний. Ідентифікуйтеся ще раз.'
				}
			},
		},
		invalidLink: {
			title: 'Посилання недоступне',
			text: 'Це посилання недійсне, застаріле або вже використане.',
			requestNew: 'Отримати нове посилання',
		},
		logout: {
			title: 'Вихід',
			text: 'Ви вийдете з усіх застосунків, у які зараз увійшли.',
			submit: 'Вийти',
		},
		terminal: {
			enrolTitle: 'Зареєструвати цей комп’ютер як термінал',
			enrolText:
				'На цьому комп’ютері люди входитимуть через застосунки, для яких його налаштовано. Під час реєстрації ви вийдете з цього браузера, щоб термінал ніколи не залишався у вашому обліковому записі.',
			label: 'Назва термінала',
			labelProblem: (max) => `Використайте 1–${max} символів.`,
			submit: 'Зареєструвати й вийти',
			enrolledTitle: 'Термінал зареєстровано',
			enrolledText: (label) => `Цей браузер тепер є терміналом ${label}. Ви вийшли. Які застосунки він обслуговує, визначає адміністратор.`,
		},
		invitation: {
			title: 'Прийняття запрошення',
			text: 'Прийміть запрошення. Далі ви ввійдете із запрошеною адресою або створите пароль, якщо запрошення створює новий обліковий запис.',
			submit: 'Прийняти запрошення',
			createTitle: 'Створіть пароль',
			createText: (address) =>
				`Для входу у ваш обліковий запис використовуватимуться адреса ${address} і пароль, який ви тут створите. Створивши пароль, ви приймете запрошення.`,
			createSubmit: 'Створити пароль і прийняти',
			otherAccountTitle: 'Ви ввійшли з іншим обліковим записом',
			otherAccountText: (address) =>
				`Це запрошення створює новий обліковий запис для адреси ${address}, а цей браузер уже ввійшов з іншим обліковим записом. Спочатку вийдіть або відкрийте посилання із запрошення в іншому профілі браузера.`,
			signOut: 'Вийти',
			signInFirstTitle: 'Спочатку увійдіть',
			signInFirstText: 'Увійдіть із запрошеною адресою, а потім знову відкрийте посилання із запрошення.',
			signIn: 'Увійти',
			noAccountTitle: 'Для цієї адреси немає облікового запису',
			noAccountText: (address) =>
				`Для адреси ${address} тут немає облікового запису, і це запрошення його не створює. Попросіть того, хто вас запросив, створити обліковий запис для цієї адреси, а потім знову відкрийте посилання із запрошення.`,
			unavailableTitle: 'Запрошення недоступне',
			accountCannotAccept: 'Цей обліковий запис не може приймати запрошення.',
			wrongAddressTitle: 'Запрошення для іншої адреси',
			wrongAddressText: 'Ви ввійшли з адресою, на яку це запрошення не надсилали. Увійдіть із запрошеною адресою.',
			inviterCannotGrant: 'Людина, яка надіслала запрошення, більше не може надати цю роль. Попросіть нове запрошення.',
			roleNotEligible: 'Цей обліковий запис не може мати роль, яку надає запрошення. Зверніться до того, хто його надіслав.',
			acceptedTitle: 'Запрошення прийнято',
			acceptedText: ({ role, scope, appName }) => `Тепер у застосунку ${appName} у вас роль ${role} (${scope}).`,
			invalidTitle: 'Посилання недоступне',
			invalidText:
				'Це запрошення недійсне, застаріле, скасоване або вже використане. Якщо ви його ще не прийняли, попросіть того, хто вас запросив, надіслати його ще раз.',
		},
	},
	messages: {
		invitation: ({ appName, role, scope, inviterLabel, companyLabel, message, actionUrl, acceptance }) => {
			const what = `до застосунку ${appName} з роллю ${role} (${scope})${companyLabel === '' ? '' : `, організація: ${companyLabel}`}`
			const note = message === '' ? null : { intro: `${inviterLabel} пише:`, message }
			const accept = {
				create:
					'Щоб прийняти запрошення, відкрийте це одноразове посилання. Якщо у вас тут уже є обліковий запис, спочатку увійдіть із цією адресою; якщо немає, ви створите пароль.',
				sign_in: 'Щоб прийняти запрошення, відкрийте це одноразове посилання й увійдіть із цією адресою.',
				no_account:
					'Для цієї адреси тут ще немає облікового запису, і це запрошення його не створює. Попросіть того, хто вас запросив, створити його, а потім відкрийте це одноразове посилання й увійдіть, щоб прийняти запрошення.',
			}[acceptance]
			return {
				subject: `Запрошення до застосунку ${appName}`,
				text: [`Вас запрошено ${what}.`, ...(note === null ? [] : [note.intro, note.message]), accept, actionUrl, IGNORE_INVITATION].join('\n\n'),
				html: `<p>Вас запрошено ${escapeHtml(what)}.</p>${quotedNote(note)}<p>${escapeHtml(accept)}</p><p><a href="${
					escapeHtml(actionUrl)
				}">Прийняти запрошення</a></p><p>${escapeHtml(IGNORE_INVITATION)}</p>`,
			}
		},
		enrollment: ({ appName, actionUrl }) =>
			passwordMessage(
				appName === null ? 'Створення пароля' : `Створення пароля для застосунку ${appName}`,
				'створити пароль',
				actionUrl,
			),
		reset: ({ appName, actionUrl }) =>
			passwordMessage(
				appName === null ? 'Відновлення пароля' : `Відновлення пароля для застосунку ${appName}`,
				'відновити пароль',
				actionUrl,
			),
	},
	applicationMail: {
		button: { invitation: 'Прийняти запрошення', enrollment: 'Створити пароль', reset: 'Відновити пароль' },
		expiry: (expiresAt) => `${expiryFormat.format(new Date(expiresAt * 1000))} UTC`,
	},
}

const IGNORE_INVITATION = 'Якщо ви не очікували цього запрошення, просто проігноруйте цей лист.'

const expiryFormat = new Intl.DateTimeFormat('uk', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })

const plural = new Intl.PluralRules('uk')

/** "символ" agreeing with `count`: 1 символ, 2 символи, 5 символів (21 символ, 22 символи, 11 символів). */
function characters(count: number): string {
	switch (plural.select(count)) {
		case 'one':
			return 'символ'
		case 'few':
			return 'символи'
		default:
			return 'символів'
	}
}

function passwordMessage(subject: string, action: string, actionUrl: string): RenderedMessage {
	return {
		subject,
		text: `Скористайтеся цим одноразовим посиланням, щоб ${action}:\n\n${actionUrl}\n\nЯкщо ви цього не запитували, просто проігноруйте цей лист.`,
		html: `<p>Скористайтеся цим одноразовим посиланням, щоб ${escapeHtml(action)}:</p><p><a href="${escapeHtml(actionUrl)}">${
			escapeHtml(subject)
		}</a></p><p>Якщо ви цього не запитували, просто проігноруйте цей лист.</p>`,
	}
}

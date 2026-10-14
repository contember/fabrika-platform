# references/dev.md — previewing the application with `fabrika app dev`

`bunx fabrika app dev` serves the application on `http://127.0.0.1:3000/` through its test kit: the proxy decision,
the stand-in IAM, a throwaway schema of `FABRIKA_TEST_POSTGRES_URL`, and each SPA from its build (run
`bun run build:web` first). Use it to look at the screens, never in place of a test.

## The seed

`dev/seed.ts` runs once, before the first request. It receives the kit, the API the tests use, writes through the
endpoints, and answers whom and what the picker offers. `--seed=<module>` names another file.

```ts dev/seed.ts
import { createClient } from '@fabrika/app/client'
import type { DevSeed } from '@fabrika/app/testing'
import { contract } from '../fabrika.contract'

const seed: DevSeed<typeof contract> = async (dev) => {
	const acme = dev.scope('org', 'acme')
	const ada = dev.testCaller([{ role: 'owner', scope: acme }], {
		label: 'Ada Lovelace',
		email: 'ada@acme.example',
	})
	const ben = dev.testCaller([{ role: 'member', scope: acme }], {
		label: 'Ben Okafor',
		email: 'ben@acme.example',
	})
	const api = createClient(contract, 'api', { fetch: dev.browser(ada) })
	await api.projects.create({ orgId: acme.value, name: 'Website relaunch' })
	await api.members.invite({
		orgId: acme.value,
		email: 'cleo@acme.example',
		role: 'member',
	})
	return {
		personas: [
			{ name: 'Ada', description: 'Owns Acme: invites and assigns', caller: ada },
			{ name: 'Ben', description: 'A member who works the tasks', caller: ben },
		],
		scopes: { org: [{ value: acme.value, label: 'Acme' }] },
	}
}

export default seed
```

- A persona is a person the seed made with `dev.testCaller` (a session, never `via: 'key'`), with a unique `name` and
  a one-line `description`. The picker shows its roles, the scope values it holds them in, and `external`.
- `links` lists pages a link holder opens: `{ title, description, url }`, where `url` is what the application's own
  endpoint answered from `ctx.links.issue` (`/s/#<key>`). Never build a link URL by hand.
- `scopes` names the values the seed made, by dimension, with the label a person knows them by; the picker offers
  them for a membership role.
- Check every call the seed makes: an endpoint that refuses answers a status, and the seed goes on without its data.
  Throw when one does: a seed that throws stops `app dev` and prints its error with the stack.
- `dev.runJob('<job>')` runs a cron job from the seed (`app dev` runs none on its schedule). A job's `ctx.links` works:
  the stand-in IAM takes the job's own key. What a job's handler throws is printed with its stack, here only.

## Outside the application

- `dev/dev.env` holds the application's variables for `app dev`, one `NAME=value` per line (`#` comments, quotes
  optional). They win over the shell's; a `FABRIKA_*` name is refused. Commit it: it holds stand-in values, never a
  real secret.
- A form's challenge passes in `app dev`: the stand-in answers Turnstile's siteverify for any token. Set the form's
  `secret` variable to any value in `dev/dev.env`, and send a fresh `challengeToken` with each submission, as a test
  does: a token is single use. For the widget on a page, set the `siteKey` variable to Turnstile's always-passing test
  key `1x00000000000000000000AA`. Its token is the same every time, and `app dev` admits that one token again at each
  submission; a deployed application records it like any other, so there it passes once.
- Point an outside provider at the dev outbox: `app dev` captures every request the process sends to
  `https://outbox.invalid` (`DEV_OUTBOX_ORIGIN` of `@fabrika/app/testing`) and answers `200 {"id": …}`. The mail view
  lists each one, by the `to` and `subject` of a JSON body, and opens its body; its headers are not kept.
- The seed's second argument reads the outbox: `outside.outbox()` is every captured request, oldest first
  (`{ id, method, path, contentType, body }`), so the seed can open a link the application mailed.

```text dev/dev.env
# Stand-in values for fabrika app dev.
TURNSTILE_SECRET=dev
TURNSTILE_SITE_KEY=1x00000000000000000000AA
MAIL_API_URL=https://outbox.invalid/mail
MAIL_API_KEY=dev
```

## In the browser

- `/__fabrika/dev` is the picker: the personas, another role of the vocabulary (a membership role with a scope value),
  anonymous, the link pages, and the mail: what IAM sent and what reached the dev outbox. It speaks the vocabulary's `locale` and shows its `displayName`.
- Every SPA page carries a toolbar in the bottom corner: who you are, the personas to switch to (the page reloads as
  that caller), the picker, the link pages, and the mail. An invitation's link accepts it; the browser is the invited
  person from then on.
- The choice stays in a cookie the application never sees. The data is gone when the command stops.
- It serves this machine only (`--host` is a loopback address, `--port=0` picks a free port), answers no request
  addressed to another host name, and runs no cron job on its schedule: the seed runs one with `dev.runJob`, a test with `kit.runJob`.

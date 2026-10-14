# references/public-intake.md — the public intake recipe

A visitor who has no account submits a form on a public page, confirms the e-mail address through a link, attaches
files, and asks for a new link when the first one is lost. HR reviews the records, an HR lead edits the code lists of
open positions and of the reasons a decision records, HR exports every candidate with an audit row, and a member
checks the mail setup with a test e-mail to their own address. This file is an application of its own (`intake`); its
`package.json`, `tsconfig.json` and `src/app-kit.ts` are those of `app-setup.md`.

Every piece lets in someone who is not signed in, so ask the human before you build it, and say what each one lets the
visitor do. The visitor never reaches a handler without a credential:

1. **A public page** (`c.spa('/', { access: { public: true } })`) holds the form. It reads no data.
2. **A form** appends one row to its inbox table and answers `{ result: { received: true } }`, for a new and a known
   address alike. It runs no handler: a handler would give every anonymous request a transaction, and a different
   answer for a known address would tell a stranger who registered.
3. **A cron job** drains the inbox, creates the record, issues a link bound to it (`issues`), and sends the e-mail.
   Each form kicks it (`then: 'intake'`), so it runs within seconds of a submission; its schedule is the recovery.
4. **A link mount** serves the visitor's own record: `verify` and the record's files, under the link's key.
5. **A second form** asks for a new link. The job revokes the old one and sends a new one, within a budget per address.

## The vocabulary, the migrations and the policies

```ts src/vocabulary.ts
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'intake',
	dimensions: { candidate: {} },
	actions: {
		'candidates.read': 'Read candidate records and their files',
		'candidates.export': 'Download every candidate as a file',
		'candidates.review': 'Move a candidate through the review',
		'candidates.verify': "Confirm a candidate's e-mail address",
		'candidates.attach': 'Attach files to a candidate record',
		'candidates.invite': "Issue a candidate's portal link",
		'candidates.process': 'Register candidates and send their links',
		'positions.read': 'Read the open positions',
		'positions.manage': 'Edit the open positions',
		'reasons.manage': 'Edit the reasons a decision records',
		'exports.read': 'Read the log of candidate exports',
		'people.list': "List the application's people",
		'people.manage': "Grant and revoke the application's roles",
	},
	roles: {
		hr: { grants: ['candidates.read', 'candidates.review', 'positions.read', 'people.list'] },
		hr_lead: {
			grants: [
				'candidates.review',
				'candidates.export',
				'positions.read',
				'positions.manage',
				'reasons.manage',
				'exports.read',
				'people.list',
			],
		},
		hr_admin: {
			grants: [
				'candidates.read',
				'candidates.review',
				'positions.read',
				'people.list',
				'people.manage',
			],
		},
	},
	members: { manage: 'people.manage', list: 'people.list' },
	directory: 'labels',
})
```

- `candidate` is a top-level dimension with no members: a candidate is a record, not a scope people are invited to.
- `hr` and `hr_lead` have no `member`, so an administrator grants them in IAM, usually without a scope (a global
  grant). The code list and the export of every candidate need that grant: they are data of the whole application.
- `members` names the application's own people: everyone holding one of its roles. A holder of `people.manage`
  (`hr_admin`) grants and revokes `hr` in IAM's console without being an IAM administrator, and IAM audits each
  change; it gives only a role whose every action it holds itself, so `hr_admin` cannot give `hr_lead`. The
  application builds no role management of its own.
- `directory: 'labels'` lets every `people.list` holder read each person's label, for naming the author of a change.
  A label spells a user's address, so the approver reviews it closely.
- The link's holder and the job get their actions from the link mount and the job's `actions`, not from a role.

```sql db/migrations/20261013090000_intake.sql
CREATE TYPE candidate_status AS ENUM ('new', 'screening', 'interview', 'hired', 'rejected');
CREATE TYPE link_state AS ENUM ('due', 'issued', 'sent');

-- The link delivery is the intake job's own state: each step is recorded here before the next effect starts.
CREATE TABLE candidates (
	id UUID PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	status candidate_status NOT NULL DEFAULT 'new',
	verified_at TIMESTAMPTZ,
	link_state link_state NOT NULL DEFAULT 'due',
	link_id TEXT,
	revoke_link_id TEXT,
	sends INTEGER NOT NULL DEFAULT 0,
	window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
);

-- The review's history: one row per decision, written in the decision's own transaction.
CREATE TABLE candidate_events (
	id UUID PRIMARY KEY,
	candidate_id UUID NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
	status candidate_status NOT NULL,
	note TEXT,
	reason_id UUID,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX candidate_events_candidate ON candidate_events (candidate_id);

-- The forms' inboxes: a column per input field, of its name, except the honeypot and the challenge token. A form
-- writes its input fields only, so received_at keeps the time of the submission.
CREATE TABLE registrations (
	email TEXT NOT NULL,
	full_name TEXT NOT NULL,
	received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE resend_requests (
	email TEXT NOT NULL,
	received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```sql db/migrations/20261013090050_application_data.sql
-- Data of the whole application: the code lists an HR lead edits, and the log of every export of all candidates.
CREATE TABLE positions (
	id UUID PRIMARY KEY,
	title TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
);
CREATE TABLE reasons (
	id UUID PRIMARY KEY,
	label TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
);
CREATE TABLE candidate_exports (
	id UUID PRIMARY KEY,
	row_count INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```sql db/migrations/20261013090100_attachments.sql
CREATE TABLE fabrika_files_attachments (
	id UUID PRIMARY KEY,
	owner_id UUID,
	status TEXT NOT NULL CONSTRAINT fabrika_files_attachments_status CHECK (status IN ('pending', 'live', 'quarantined', 'rejected')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	content_type TEXT NOT NULL,
	sha256 TEXT,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ,
	object_version TEXT,
	scan_attempts INTEGER NOT NULL DEFAULT 0,
	scan_after TIMESTAMPTZ,
	FOREIGN KEY (owner_id) REFERENCES candidates (id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX fabrika_files_attachments_owner ON fabrika_files_attachments (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX fabrika_files_attachments_removable ON fabrika_files_attachments (created_at) WHERE deleted_at IS NOT NULL OR owner_id IS NULL OR status = 'pending';
CREATE INDEX fabrika_files_attachments_scan ON fabrika_files_attachments (scan_after) WHERE status = 'quarantined';
```

The file table is `fileTableSql('attachments', { table: 'candidates', key: { column: 'id', type: 'uuid' }, chain: [] })`
(`references/files.md`): a top-level owner has no chain.

```ts src/db/tables.ts
import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	candidates: {
		scope: { dimension: 'candidate' },
		actions: {
			read: 'candidates.read',
			insert: 'candidates.process',
			update: 'candidates.verify',
			appRead: ['candidates.export'],
		},
		insert: ['email', 'name'],
		update: ['verified_at'],
		version: 'version',
		createdBy: 'created_by',
		columns: {
			status: { write: 'candidates.review' },
			link_state: { read: 'candidates.process' },
			link_id: { read: 'candidates.process' },
			revoke_link_id: { read: 'candidates.process' },
			sends: { read: 'candidates.process' },
			window_started_at: { read: 'candidates.process' },
		},
	},
	candidate_events: {
		scope: { child: 'candidates' },
		actions: { read: 'candidates.read', insert: 'candidates.review' },
		insert: ['status', 'note', 'reason_id'],
		createdBy: 'created_by',
	},
	registrations: { scope: { inbox: 'register', read: 'candidates.process' } },
	resend_requests: { scope: { inbox: 'resend', read: 'candidates.process' } },
	positions: {
		scope: { app: 'the open positions an HR lead edits' },
		actions: {
			read: 'positions.read',
			insert: 'positions.manage',
			update: 'positions.manage',
		},
		insert: ['title'],
		update: ['title', 'active'],
		version: 'version',
		createdBy: 'created_by',
	},
	reasons: {
		scope: { app: 'the reasons a decision records, which an HR lead edits' },
		actions: {
			read: 'candidates.review',
			insert: 'reasons.manage',
			update: 'reasons.manage',
		},
		insert: ['label'],
		update: ['label', 'active'],
		version: 'version',
		createdBy: 'created_by',
	},
	candidate_exports: {
		scope: { app: 'the log of every export of all candidates' },
		actions: { read: 'exports.read', insert: 'candidates.export' },
		insert: ['row_count'],
		createdBy: 'created_by',
	},
})
```

- `{ inbox: '<form>', read }` is a form's table: only that form appends to it, and only a site that holds `read` and
  declares the reach reads it. No site writes it: `unscoped: { registrations: 'write' }` is refused.
- `{ app: '<why>' }` is an application table: its rows belong to no candidate. An endpoint declared
  `access: { action, app: true }` reads and writes it through `ctx.db.app`, with the action the operation names. An
  endpoint `on`, `in` or `over` a candidate reads it, read-only and every row, where its action is the table's read
  action: `decide` reads `reasons` with `candidates.review`. A position or a reason is deactivated, never deleted, so
  neither table has a delete action. `candidate_exports` is appended with the export's own action, `candidates.export`,
  and read with `exports.read`.
- The form writes each input field to the column of the same name: `full_name`, never `fullName`. tsc refuses another
  name at the form's `appendTo`, and the checker refuses it too. A `ctx.sql` row still reads it as `fullName`.
- The form writes nothing else, so an inbox records the time of a submission only in a `DEFAULT now()` column
  (`received_at`). The job's own `now()` is later: seconds after a kick, up to a minute when the schedule recovers it.
- The delivery columns are read only with `candidates.process`, so neither HR nor the link's holder sees them.

## The contract

```ts src/schemas.ts
import { z } from 'zod/v4'

export const CandidateStatus = z.enum([
	'new',
	'screening',
	'interview',
	'hired',
	'rejected',
])
export const Register = z.strictObject({
	email: z.email().max(200),
	full_name: z.string().min(1).max(200),
	website: z.optional(z.string().max(200)),
	challengeToken: z.string().max(4096),
})
export const Resend = z.strictObject({ email: z.email().max(200) })
export const Me = z.strictObject({
	name: z.string(),
	email: z.string(),
	verified: z.boolean(),
})
export const Verified = z.strictObject({ verifiedAt: z.iso.datetime() })
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { candidates } from './src/candidates/endpoints'
import { intake } from './src/intake/endpoints'
import { portal } from './src/portal/endpoints'
import { positions } from './src/positions/endpoints'
import { reasons } from './src/reasons/endpoints'
import { Register, Resend } from './src/schemas'
import { settings } from './src/settings/endpoints'

export const contract = app.contract((c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	register: c.form('/register', {
		input: Register,
		appendTo: 'registrations',
		maxBytes: 4096,
		honeypot: 'website',
		challenge: {
			provider: 'turnstile',
			secret: 'TURNSTILE_SECRET',
			siteKey: 'TURNSTILE_SITE_KEY',
		},
		then: 'intake',
	}),
	resend: c.form('/resend', {
		input: Resend,
		appendTo: 'resend_requests',
		maxBytes: 1024,
		then: 'intake',
	}),
	portal,
	api: c.rpc('/api', { candidates, positions, reasons, settings }),
	hr: c.spa('/hr', {
		dir: 'dist/hr',
		access: { action: 'candidates.read', over: 'candidate' },
	}),
	files: {
		attachments: c.files({
			owner: 'candidates',
			read: 'candidates.read',
			write: 'candidates.attach',
			delete: 'candidates.review',
			maxBytes: 10485760,
			types: ['application/pdf'],
			maxPerOwner: 5,
			link: true,
			scan: true,
		}),
	},
	jobs: { intake },
	health: c.health('/healthz'),
}))
```

- **The public page.** `access: { public: true }` serves the SPA to anyone, without a token, and takes no other key.
  At `/` it answers every `GET` that no more specific endpoint serves, so the HR SPA (`/hr`) and the link's SPA (`/p`)
  keep their own. The approver sees it as "for anyone, without signing in". Put nothing on it that only members may
  read: the page calls no procedure.
- **The form's abuse control.** `honeypot` names an optional string field the page hides: a filled one gets the same
  answer and writes no row. `challenge` makes the framework verify the Turnstile token in `challengeToken` before it
  writes the row (a failed token 400, an unreachable provider 503, no row either way) and adds Turnstile's origin to
  the CSP. `TURNSTILE_SECRET` is an application variable the human sets; without it the application does not boot.
  `siteKey` names the variable with the widget's public site key, which every SPA mount serves its pages; without it
  the application does not boot either. Another public value a page needs per environment (a link target) goes in
  the SPA mount's own list: `c.spa('/', { …, public: ['SIGNUP_URL'] })`. Both reach the page in
  `<prefix>/__fabrika-config.json` as `public: { <VARIABLE>: <value> }`, and the approver sees each name. Never name
  a secret there: the contract refuses a variable that is both.
  `rate: { perClient, perForm }` (per minute, 10 and 100 by default) answers 429 past either limit.
- **Zerops shares one client address.** Until the platform reads the visitor's address behind the Zerops balancer,
  every visitor counts as one client there, so `perClient` acts as a second per-form limit: set it to the form's
  expected peak, never lower it to stop a flood. The challenge is the defense that does not depend on the address.
- **Counting clicks** on a public page has no primitive. The pattern is an anonymous form without a challenge whose
  inbox gets one row per click, posted with `fetch(…, { keepalive: true })`. Know both limits before you offer it:
  anyone can inflate the counts (the rate limits bound only how fast), and nothing drains the inbox but a job you
  write. Ask the human first; usually the application should not count clicks.
- **Other origins** the pages load (an image host, an API the browser calls) go in the contract's `csp` section:
  `csp: { scriptSrc: [{ origin: 'https://…', purpose: '…' }] }`, beside `connectSrc`, `imgSrc`, `frameSrc`,
  `styleSrc`, `fontSrc` and `frameAncestors`: exact `https://` origins, at most 16 each. Each new origin is a widening the approver sees.
- **Scanned files.** A visitor's upload waits `quarantined` until ClamAV answers clean (`references/files.md`): its
  download answers 409 until then. On Zerops the deploy service needs `verticalAutoscaling: { minRam: 2 }`.
- **The kick.** `then: 'intake'` makes each accepted submission start a run of the job within seconds, once its row
  committed, under the job's own key. The visitor's answer is the same constant and never waits for the run. Kicks
  coalesce on the job's lease (at most one run and one pending, however many visitors submit), so a flood adds no
  work: the run still drains the inbox in batches of 50, within each address's budget. A kick carries nothing; the
  job reads its inbox.

## The job: inbox → record → link → e-mail

```ts src/mail.ts
import { defineDeps } from '@fabrika/app/implement'

export interface Mailer {
	/** Sends the link to `to`; throws when the provider refuses, and gives up once `signal` aborts. */
	sendLink(to: string, url: string, signal: AbortSignal): Promise<void>
	/** Sends a fixed test message to `to`, the same way. */
	sendTest(to: string, signal: AbortSignal): Promise<void>
}

interface Message {
	readonly to: string
	readonly subject: string
	readonly text: string
}

/** Read when a mail is sent: the generated tests boot the application without its variables. */
const variable = (env: Readonly<Record<string, unknown>>, name: string) => {
	const value = env[name]
	if (typeof value !== 'string' || value === '') {
		throw new Error(`the application variable ${name} is not set`)
	}
	return value
}

export const mailer = defineDeps((env): Mailer => {
	const send = async (message: Message, signal: AbortSignal) => {
		const response = await fetch(variable(env, 'MAIL_API_URL'), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${variable(env, 'MAIL_API_KEY')}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(message),
			signal,
		})
		if (!response.ok) {
			throw new Error(`the mail provider answered ${response.status}`)
		}
	}
	return {
		sendLink: (to, url, signal) =>
			send({
				to,
				subject: 'Confirm your address',
				text: `Open ${
					variable(env, 'INTAKE_ORIGIN')
				}${url} to confirm your address.`,
			}, signal),
		sendTest: (to, signal) =>
			send({
				to,
				subject: 'A test e-mail from the intake',
				text: 'The intake can send you e-mail.',
			}, signal),
	}
})
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { mailer } from './mail'

export default serve(contract, { database: scoped(tables), deps: mailer })
```

```ts src/intake/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { mailer } from '../mail'

const Registration = z.strictObject({ email: z.string(), fullName: z.string() })
const Ask = z.strictObject({ email: z.string() })
const Id = z.strictObject({ id: z.string() })
const Due = z.strictObject({
	id: z.string(),
	email: z.string(),
	linkState: z.enum(['due', 'issued', 'sent']),
	linkId: z.nullable(z.string()),
	revokeLinkId: z.nullable(z.string()),
})

/** A link lives a week; an address gets at most three e-mails a day, failed deliveries included. */
const LINK_DAYS = 7
const SENDS_PER_DAY = 3

export const intake = app.cron('* * * * *', {
	actions: [
		'candidates.process',
		'candidates.invite',
		'candidates.read',
		'candidates.verify',
		'candidates.attach',
	],
	scope: 'app',
	retries: 0,
	sql: 'write',
	issues: 'portal',
})
	.handle(async ({ ctx }) => {
		const mail = mailer.get()
		// A registration becomes a candidate once; the form told the visitor nothing either way.
		await ctx.transaction(async (tx) => {
			const rows = await tx.sql(Registration)`
				delete from registrations returning email, full_name`
			for (const row of rows) {
				await tx.sql(Id)`
					insert into candidates (id, email, name, created_by, version)
					values (${crypto.randomUUID()}, ${row.email}, ${row.fullName}, ${ctx.principal.id}, 1)
					on conflict (email) do nothing
					returning id`
			}
		})
		// A resend supersedes the sent link of an unverified candidate while its budget has an e-mail left.
		await ctx.transaction(async (tx) => {
			for (
				const ask of await tx.sql(Ask)`delete from resend_requests returning email`
			) {
				await tx.sql(Id)`
					update candidates
					set link_state = 'due', revoke_link_id = link_id, link_id = null
					where email = ${ask.email} and verified_at is null and link_state = 'sent'
						and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
					returning id`
			}
		})
		// Only a row whose budget has an e-mail left: spent rows would fill the batch and starve the rest.
		const due = await ctx.transaction((tx) =>
			tx.sql(Due)`
				select id, email, link_state, link_id, revoke_link_id
				from candidates
				where link_state <> 'sent'
					and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				order by id limit 50`
		)
		for (const candidate of due) {
			// The e-mail is charged before any effect; without one left, the row waits as it is.
			const reserved = await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set
						sends = case when window_started_at < now() - interval '1 day' then 1 else sends + 1 end,
						window_started_at = case when window_started_at < now() - interval '1 day'
							then now() else window_started_at end
					where id = ${candidate.id}
						and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
					returning id`
			)
			if (reserved.length === 0) continue
			// A link issued but not known to be e-mailed, or one a resend superseded, ends first.
			const superseded = candidate.linkState === 'issued'
				? candidate.linkId
				: candidate.revokeLinkId
			if (superseded !== null) {
				ctx.signal.throwIfAborted()
				await ctx.links.revoke(superseded)
				await ctx.transaction((tx) =>
					tx.sql(Id)`
						update candidates set link_state = 'due', link_id = null, revoke_link_id = null
						where id = ${candidate.id} returning id`
				)
			}
			ctx.signal.throwIfAborted()
			const ref = await ctx.ref('candidates.invite', 'candidate', candidate.id)
			const link = await ctx.links.issue(ref, { mount: 'portal', days: LINK_DAYS })
			await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set link_state = 'issued', link_id = ${link.id}
					where id = ${candidate.id} returning id`
			)
			ctx.signal.throwIfAborted()
			await mail.sendLink(candidate.email, link.url, ctx.signal)
			await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set link_state = 'sent'
					where id = ${candidate.id} and link_id = ${link.id} returning id`
			)
		}
	})
```

The job keeps three invariants. Keep them when you change it:

- **The budget is charged first.** Each delivery reserves one e-mail of the address's daily budget, in its own
  transaction, before any effect. A delivery that fails after the e-mail left is still counted, so a provider that
  times out cannot make the job mail one address without end. Only a row with an e-mail left is selected for the batch
  of 50, so spent rows never crowd out the others; the reservation checks the budget again in its own transaction.
- **Each step is recorded before the next effect.** Revoke a superseded link, then record it; issue, then record the
  link's id (`issued`); send, then record `sent`. A run that stops anywhere (a crash, a refused e-mail, IAM down) is
  finished by the next run its budget allows: an `issued` row's link is revoked and replaced, so exactly one live link
  was e-mailed. The e-mail is at least once. The link's key is never stored: only the job saw it.
- **An effect starts only while the attempt is live.** `ctx.signal.throwIfAborted()` runs before each IAM call and the
  e-mail, and the e-mail takes `ctx.signal`. The runner aborts a timed-out attempt before the next one starts, so no
  effect of a stale attempt follows the next one's. `ctx.links` itself refuses to call IAM for an ended attempt.

More on the job:

- **`issues: 'portal'`** gives the job `ctx.links.issue(ref, { mount, days })` and `ctx.links.revoke(id)` for the
  links it issued. Its `actions` must hold the mount's `issuedBy` and every grant of the mount, or the contract is
  refused: IAM lets an issuer delegate only what it holds. The link is bound to one candidate (the `Ref`), and the
  approver sees the job's `issues` marked "needs closer review".
- **`sql: 'write'`** is the declared reach into the inboxes: `delete … returning` takes each row exactly once. A job is
  app-wide, so its statements need no scope fragment (`tx.sql.scope` of its `Within` is every row).
- **The latency.** The forms' kick starts a run within seconds of a submission, so the e-mail leaves seconds later,
  while the address has an e-mail of its daily budget left; a spent one waits until a day after the window's first
  e-mail. Keep the schedule (`* * * * *`): it is the recovery path. A kicked run that dies (a crash, a deploy, a
  refused e-mail) leaves its rows, and the next scheduled run finishes them, within a minute. `retries: 0`: that run
  is the retry. A failed run leaves a pending kick to the schedule too.
- **A revoked link** still works until the token the proxy holds for it expires, at most 5 minutes. Revocation is the
  stop at IAM; it is not instant.
- The e-mail goes through `deps` (`src/mail.ts`), built from application variables the human sets (`INTAKE_ORIGIN`,
  `MAIL_API_URL`, `MAIL_API_KEY`). `link.url` is `/p/#<key>`: the key is in the fragment, which no server and no
  `Referer` sees.

## The visitor's link: verify once, attach files

```ts src/portal/endpoints.ts
import { app } from '../app-kit'
import { Me, Verified } from '../schemas'

export const portal = app.link('/p', {
	spa: 'dist/portal',
	dimension: 'candidate',
	grants: ['candidates.read', 'candidates.verify', 'candidates.attach'],
	issuedBy: 'candidates.invite',
	maxDays: 7,
	procedures: (l) => ({
		me: l.query({ output: Me, access: { action: 'candidates.read' } })
			.handle(async ({ ctx }) => {
				const row = await ctx.db.target.get()
				return {
					name: row.name,
					email: row.email,
					verified: row.verified_at !== null,
				}
			}),
		verify: l.mutation({
			output: Verified,
			access: { action: 'candidates.verify' },
		})
			.handle(async ({ ctx }) => {
				const row = await ctx.db.target.getForUpdate()
				if (row.verified_at !== null) {
					return { verifiedAt: row.verified_at.toISOString() }
				}
				const now = new Date()
				await ctx.db.target.update({ verified_at: now }, {
					expectVersion: row.version,
				})
				return { verifiedAt: now.toISOString() }
			}),
	}),
})
```

- **Single use is the application's state.** `verify` sets `verified_at` once, under `getForUpdate`; a second call
  answers the same time. IAM counts no uses: the proxy honors a token it holds without asking IAM.
- A link procedure acts on the link's own object: no `from`, no id in the input. A key of another candidate reaches
  only that candidate's record, and a key whose candidate is gone answers 404.
- `link: true` on the collection serves the holder `POST /p/api/files.attachments.upload?name=<name>` (the body is the
  file), `POST /p/api/files.attachments.list` (`{ limit?, after? }`) and `GET /p/api/files.attachments/:fileId`, for
  the link's candidate only: another candidate's file id answers 404. The mount must grant the collection's `write`
  and `read`. HR reaches the same files under `/api/files.attachments…` with `candidates.read`. A second link mount
  on candidates that must not reach the files (a one-click answer) needs `link: ['portal']` instead.

```ts web/portal/main.ts
import { createClient, RpcError, shareKey } from '@fabrika/app/client'
import { contract } from '../../fabrika.contract'

const key = shareKey()
const portal = key === null ? null : createClient(contract, 'portal', { key })

export const confirm = async (status: HTMLElement): Promise<void> => {
	if (portal === null) {
		status.textContent = 'This link holds no key.'
		return
	}
	try {
		const me = await portal.me()
		await portal.verify()
		status.textContent = `${me.name}, your address is confirmed.`
	} catch (error) {
		status.textContent = error instanceof RpcError
			? 'This link no longer works: ask for a new one.'
			: 'Failed'
	}
}

export const attach = async (file: File): Promise<string> => {
	if (key === null) return 'This link holds no key.'
	const response = await fetch(
		`/p/api/files.attachments.upload?name=${encodeURIComponent(file.name)}`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': file.type },
			body: file,
		},
	)
	return response.ok ? 'Received: it is being checked.' : 'Refused.'
}
```

The public page reads its site key from the config the framework serves it, so one build serves every environment.

```ts web/site/config.ts
import { z } from 'zod/v4'

const SiteConfig = z.object({
	public: z.object({ TURNSTILE_SITE_KEY: z.string() }),
})

/** The Turnstile widget's site key, or `null` when the config is unreadable. */
export const siteKey = async (): Promise<string | null> => {
	const response = await fetch('/__fabrika-config.json')
	const config = SiteConfig.safeParse(response.ok ? await response.json() : null)
	return config.success ? config.data.public.TURNSTILE_SITE_KEY : null
}
```

The public page sends the form with a plain `fetch`: a form has no typed client, and its answer never depends on the
data.

```ts web/site/register.ts
export const register = async (
	form: HTMLFormElement,
	challengeToken: string,
): Promise<boolean> => {
	const data = new FormData(form)
	const field = (name: string) => {
		const value = data.get(name)
		return typeof value === 'string' ? value : ''
	}
	const response = await fetch('/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: field('email'),
			full_name: field('full_name'),
			website: field('website'),
			challengeToken,
		}),
	})
	return response.ok
}
```

- The page renders the Turnstile widget with the site key `siteKey()` reads and `action` set to the form's mount name
  (`register`), and passes the widget's token. Say "check your inbox" on success whatever the address was.
- The resend form is the same call to `/resend` with `{ email }`. It answers the same for an unknown, a verified and a
  rate-limited address; the job decides.
- Build each SPA into its `dir` (`dist/site`, `dist/portal`, `dist/hr`): one `Bun.build` per `index.html` in
  `build-web.ts`.

## HR: the list, the review and its history

```ts src/candidates/logic.ts
type Status = 'new' | 'screening' | 'interview' | 'hired' | 'rejected'

const NEXT: Readonly<Record<Status, readonly Status[]>> = {
	new: ['screening', 'rejected'],
	screening: ['interview', 'rejected'],
	interview: ['hired', 'rejected'],
	hired: [],
	rejected: [],
}

export const canMove = (from: Status, to: Status): boolean =>
	NEXT[from].includes(to)

/**
 * The stage HR sees. Two actions set the two columns it derives from: the link holder's `candidates.verify` sets
 * `verified_at`, HR's `candidates.review` sets `status`. A column has one write action, so the state is two columns.
 */
export const stageOf = (
	status: Status,
	verifiedAt: Date | null,
): Status | 'unconfirmed' => (verifiedAt === null ? 'unconfirmed' : status)
```

```ts src/candidates/endpoints.ts
import { BadRequestError, ConflictError, fromPage, fromRow } from '@fabrika/app'
import { attachment } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { CandidateStatus } from '../schemas'
import { canMove } from './logic'

const Cursor = z.string().max(500)
const Candidate = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	email: z.string(),
	status: CandidateStatus,
	verifiedAt: z.nullable(z.iso.datetime()),
	version: z.int(),
})
const CandidatePage = z.strictObject({
	items: z.array(Candidate),
	next: z.nullable(z.string()),
})
const Event = z.strictObject({
	status: CandidateStatus,
	note: z.nullable(z.string()),
	createdBy: z.string(),
	createdAt: z.iso.datetime(),
})
const History = z.strictObject({
	items: z.array(Event),
	next: z.nullable(z.string()),
})
const ListCandidates = z.strictObject({
	status: CandidateStatus.optional(),
	after: Cursor.optional(),
})
const ById = z.strictObject({ id: z.uuid() })
const HistoryOf = z.strictObject({ id: z.uuid(), after: Cursor.optional() })
const Decide = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	status: CandidateStatus,
	note: z.nullable(z.string().max(2000)),
	reasonId: z.nullable(z.uuid()),
})
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
const ExportRow = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	email: z.string(),
	status: CandidateStatus,
})
const CandidateFile = attachment({
	format: 'csv',
	filename: 'candidates.csv',
	row: ExportRow,
	maxBytes: 4194304,
})
const ExportEntry = z.strictObject({
	rowCount: z.int(),
	createdBy: z.string(),
	createdAt: z.iso.datetime(),
})
const ExportLog = z.strictObject({
	items: z.array(ExportEntry),
	next: z.nullable(z.string()),
})
const LogPage = z.strictObject({ after: Cursor.optional() })
const Person = z.strictObject({
	principalId: z.string(),
	name: z.nullable(z.string()),
	active: z.boolean(),
})
const People = z.strictObject({
	items: z.array(Person),
	next: z.nullable(z.string()),
})

/** The file's row limit: a larger export is refused, never cut short. */
const MAX_EXPORT_ROWS = 10000

export const candidates = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: ListCandidates,
		output: CandidatePage,
		access: { action: 'candidates.read', over: 'candidate' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Candidate,
				await ctx.db.within.candidates.list({
					where: input.status === undefined
						? []
						: [['status', '=', input.status]],
					orderBy: [['name', 'asc']],
					after: input.after,
				}),
			)
		),
	get: r.query({
		input: ById,
		output: Candidate,
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ ctx }) => fromRow(Candidate, await ctx.db.target.get())),
	history: r.query({
		input: HistoryOf,
		output: History,
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Event,
				await ctx.db.target.candidate_events.list({
					orderBy: [['created_at', 'asc']],
					after: input.after,
				}),
			)
		),
	decide: r.mutation({
		input: Decide,
		output: Saved,
		access: { action: 'candidates.review', on: 'candidate', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const candidate = await ctx.db.target.getForUpdate()
			if (!canMove(candidate.status, input.status)) {
				throw new ConflictError(
					`a ${candidate.status} candidate does not move to ${input.status}`,
				)
			}
			if (input.reasonId !== null) {
				const known = await ctx.db.app.reasons.count({
					where: [['id', '=', input.reasonId], ['active', '=', true]],
				})
				if (known === 0) {
					throw new BadRequestError(
						`the reason ${input.reasonId} is unknown or retired`,
					)
				}
			}
			await ctx.db.target.candidate_events.insert({
				status: input.status,
				note: input.note,
				reason_id: input.reasonId,
			})
			return ctx.db.target.update({ status: input.status }, {
				expectVersion: input.expectVersion,
			})
		}),
	export: r.mutation({
		output: CandidateFile,
		access: { action: 'candidates.export', app: true },
	})
		.handle(async ({ ctx }) => {
			const rows: z.output<typeof ExportRow>[] = []
			let after: string | undefined
			do {
				const page = await ctx.db.app.candidates.list({
					orderBy: [['name', 'asc']],
					limit: 500,
					after,
				})
				rows.push(...page.items.map((row) => fromRow(ExportRow, row)))
				after = page.next ?? undefined
			} while (after !== undefined && rows.length <= MAX_EXPORT_ROWS)
			if (rows.length > MAX_EXPORT_ROWS) {
				throw new ConflictError(
					`more than ${MAX_EXPORT_ROWS} candidates: export a filtered list`,
				)
			}
			await ctx.db.app.candidate_exports.insert({ row_count: rows.length })
			return rows
		}),
	exports: r.query({
		input: LogPage,
		output: ExportLog,
		access: { action: 'exports.read', app: true },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				ExportEntry,
				await ctx.db.app.candidate_exports.list({
					orderBy: [['created_at', 'desc']],
					after: input.after,
				}),
			)
		),
	people: r.query({
		input: LogPage,
		output: People,
		access: { action: 'people.list', app: true },
	})
		.handle(async ({ input, ctx }) => {
			const page = await ctx.members.list({ after: input.after })
			return {
				items: page.members.map((person) => ({
					principalId: person.principalId,
					name: person.label,
					active: !person.disabled,
				})),
				next: page.next,
			}
		}),
}))
```

- **A code list an administrator edits is validated by reading it.** `decide` runs `on` one candidate with
  `candidates.review`, the read action of `reasons`, so `ctx.db.app.reasons` reads every reason there, read-only. A
  reason that is unknown or retired answers 400 that names it, before anything is written. Do not let a foreign key
  stand in for the check: its failure is a 500 that names no value.
- **Application history is a table on the paved road.** `decide` writes its `candidate_events` row through the
  handle, in the invocation's one transaction: the status and its history row commit together or not at all, and
  `created_by` is the caller. There is no framework audit API; never write history from a job or after the answer.
- **The author of a change is named from the application's directory.** A history row keeps `created_by`, the
  principal id; `people` answers every person holding a role of the application with their current label, a page of
  at most 100 at a time, and the HR SPA names each `createdBy` from it. Never copy a label into the row: a person's
  label changes, and the directory is the one current answer. `ctx.members.list()` exists only on an `app: true`
  endpoint whose action is the vocabulary's `members.list`, and IAM checks that action live, held globally.
- **An audited export of every candidate** is one `app` mutation under an action of its own, `candidates.export`.
  `ctx.db.app.candidates` lists every candidate, read-only, because the candidates' policy names that action in its
  `appRead`, and the log row goes into `candidate_exports`, whose insert action is the export's, in the invocation's
  one transaction. The file is encoded before the commit, so no file leaves without its row
  (`references/endpoint.md`). It needs no `sql` and no `unscoped`. HR reads every candidate and may not export them:
  a global holder of only `candidates.read` gets 403 from the export; the HR lead's role grants `candidates.export`.
- **`app: true` is for data of the whole application.** The proxy admits the endpoint only for a caller who holds the
  action as a global grant: an HR member granted `candidates.read` on one candidate gets 403. `list` and `get` stay
  `over` and `on`, which serve a scoped grant too.
- `over: 'candidate'` lists every candidate a caller holds `candidates.read` on. HR holds it globally, so
  `ctx.within.values` is `'all'`.
- The generated case of `decide` sends the first status (`new`) to a record that is `new`, which `canMove` refuses
  with 409. Give it an input in `src/__tests__/endpoint-access.fixtures.ts`:

```ts src/__tests__/endpoint-access.fixtures.ts
export const fixtures = {
	'api.candidates.decide': {
		id: '00000000-0000-4000-8000-000000000000',
		expectVersion: 1,
		status: 'screening',
		note: null,
		reasonId: null,
	},
}
```

## The code list an HR lead edits

```ts src/positions/endpoints.ts
import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Position = z.strictObject({
	id: z.uuid(),
	title: z.string(),
	active: z.boolean(),
	version: z.int(),
})
const Positions = z.strictObject({
	items: z.array(Position),
	next: z.nullable(z.string()),
})
const Page = z.strictObject({ after: z.string().max(500).optional() })
const NewPosition = z.strictObject({ title: z.string().min(1).max(200) })
const EditPosition = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	title: z.string().min(1).max(200),
	active: z.boolean(),
})
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })

export const positions = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: Page,
		output: Positions,
		access: { action: 'positions.read', app: true },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Position,
				await ctx.db.app.positions.list({
					orderBy: [['title', 'asc']],
					after: input.after,
				}),
			)
		),
	add: r.mutation({
		input: NewPosition,
		output: Saved,
		access: { action: 'positions.manage', app: true },
	})
		.handle(({ input, ctx }) =>
			ctx.db.app.positions.insert({ title: input.title })
		),
	edit: r.mutation({
		input: EditPosition,
		output: Saved,
		access: { action: 'positions.manage', app: true },
	})
		.handle(({ input, ctx }) =>
			ctx.db.app.positions.update(input.id, {
				title: input.title,
				active: input.active,
			}, { expectVersion: input.expectVersion })
		),
}))
```

```ts src/reasons/endpoints.ts
import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Reason = z.strictObject({
	id: z.uuid(),
	label: z.string(),
	active: z.boolean(),
	version: z.int(),
})
const Reasons = z.strictObject({
	items: z.array(Reason),
	next: z.nullable(z.string()),
})
const Page = z.strictObject({ after: z.string().max(500).optional() })
const NewReason = z.strictObject({ label: z.string().min(1).max(200) })
const EditReason = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	label: z.string().min(1).max(200),
	active: z.boolean(),
})
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })

export const reasons = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: Page,
		output: Reasons,
		access: { action: 'candidates.review', app: true },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Reason,
				await ctx.db.app.reasons.list({
					orderBy: [['label', 'asc']],
					after: input.after,
				}),
			)
		),
	add: r.mutation({
		input: NewReason,
		output: Saved,
		access: { action: 'reasons.manage', app: true },
	})
		.handle(({ input, ctx }) =>
			ctx.db.app.reasons.insert({ label: input.label })
		),
	edit: r.mutation({
		input: EditReason,
		output: Saved,
		access: { action: 'reasons.manage', app: true },
	})
		.handle(({ input, ctx }) =>
			ctx.db.app.reasons.update(input.id, {
				label: input.label,
				active: input.active,
			}, { expectVersion: input.expectVersion })
		),
}))
```

- `ctx.db.app.<table>` of an application table has `list`, `count` and `aggregate` with its read action, `get(id)`
  with any action it names, and in a mutation `getForUpdate(id)`, `insert(v)`, `update(id, v, { expectVersion })` and
  `remove(id, { expectVersion })` with the operation's action. Its key is generated on insert.
- The HR SPA reads the list with `positions.read`; an HR lead's page adds and edits with `positions.manage`. A
  position that is no longer open is deactivated, so a record that names it keeps its meaning. The reasons work the
  same way under `reasons.manage`.
- The table's read action decides who reads it. An endpoint `on`, `in` or `over` a candidate reads `reasons` (`list`,
  `count`, `aggregate`, `get(id)`, every row, no write) only where its action is `candidates.review`; with another
  action `ctx.db.app.reasons` is a type error that names the read action, and a refusal at run time. So the HR lead's
  list of reasons runs with `candidates.review` too, and the role grants it.
- A list no person edits, changed only with the code, is a reference table (`references/table-and-migration.md`).

## A test e-mail to yourself

```ts src/settings/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { mailer } from '../mail'

const Sent = z.strictObject({ sentTo: z.string() })

/** How long the provider may take: a request has no signal of its own. */
const SEND_TIMEOUT_MS = 10000

export const settings = app.group({ callers: ['human'] }, (r) => ({
	testMail: r.mutation({ output: Sent, access: { member: true } })
		.handle(async ({ ctx }) => {
			const to = ctx.principal.email
			await mailer.get().sendTest(to, AbortSignal.timeout(SEND_TIMEOUT_MS))
			return { sentTo: to }
		}),
}))
```

- **The address is the caller's, from the token.** `ctx.principal.email` is the mailbox IAM recorded for the person
  (lower-cased), so the input has no address field. IAM recorded it; how far it checked that the person controls it is
  its login method's (an operator may accept an IdP's unverified address). An input that named one would let any member mail any address
  past every consent the application asks for. Never take a recipient from the input for "send it to me".
- `{ member: true }` admits any member of the application and reaches no data: the endpoint mails only the caller.
  The generated tests give a `member` endpoint no case, so the test below is yours.
- The page shows the button only to someone signed in: its SPA reads `/hr/__fabrika-me.json` (`references/app-setup.md`).

## Tests

- The generated tests cover HR's endpoints, the files and the link's procedures: the endpoint access kit asks each
  link procedure as a holder of a key bound to a seeded candidate. Each `app` endpoint gets two cases: a holder of
  its action in one candidate only is 403, and a global holder reaches it. `positions`, `reasons` and
  `candidate_exports` get a policy probe of their actions, held globally and in one scope, and of a scoped site that
  reads every row with the read action and none with another. The probe of `candidates` also lists every candidate
  from an `app` endpoint of `candidates.export`, its `appRead`. An endpoint that `issues` gets the cases of any `on`
  endpoint: the generated tests' stand-in IAM issues its link (`references/tests.md`).
- Test the export's own action beside its refused twin: a global holder of `candidates.export` downloads the file, a
  global holder of only `candidates.read` gets 403.
- Your own test of a link procedure makes the holder `kit.testCaller([{ action: 'candidates.verify', scope: { type:
  'candidate', value: id } }], { kind: 'link', link: { mount: 'portal', chain: [{ type: 'candidate', value: id }] }
  })` and calls `createClient(contract, 'portal', { fetch: kit.fetch, key: holder.key ?? '' })`.
- The job asks IAM to issue and revoke links, and the kit's own IAM answers only the credentials of its callers, not a
  job's key, so `kit.runJob('intake')` needs `testKit(app, { membership })` with an `IamMembershipRpc` of your own that
  answers `issueLink` and `revokeLink`. A test of a form passes `env: {
  TURNSTILE_SECRET: '…', TURNSTILE_SITE_KEY: '…' }` and `challengeFetch`, a stand-in for Turnstile's answer, to `testKit`, and a fresh
  `challengeToken` with each submission: a token is single use. Test each stop of a delivery (a refused e-mail, IAM
  down, a crash after each step): the next run must leave exactly one live, e-mailed link.
- A test that submits a form kicks the job too, and the kicked run may start at once: arm a fault before the
  submission, never between it and the run. `kit.runJob('intake')` first waits for the kicked runs, then runs once.
- The e-mail provider is a stand-in too: `testKit(app, { env: { MAIL_API_URL, MAIL_API_KEY: 'test', INTAKE_ORIGIN:
  'https://intake.test' } })` points the mailer at a test URL, which `standInMail()` answers. Call its `restore()` in
  `afterEach`.
- The test e-mail goes to the caller's own address: the test sends no address and reads the recipient from the stand-in.

```ts src/__tests__/mail-stand-in.ts
import { spyOn } from 'bun:test'

/** The mail provider of a test; `env.MAIL_API_URL` points the mailer here. */
export const MAIL_API_URL = 'https://mail.test/send'

/** Answers the mail provider's URL and keeps each mail; every other request goes on to the real `fetch`. */
export const standInMail = () => {
	const sent: string[] = []
	const passOn = globalThis.fetch
	const answer = async (...args: Parameters<typeof fetch>) => {
		const request = new Request(...args)
		if (request.url !== MAIL_API_URL) return passOn(...args)
		sent.push(await request.text())
		return new Response(null, { status: 202 })
	}
	const spy = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(answer, { preconnect: passOn.preconnect }),
	)
	return { sent, restore: () => spy.mockRestore() }
}
```

```ts src/__tests__/settings.test.ts
import { createClient } from '@fabrika/app/client'
import { type IamMembershipRpc, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { contract } from '../../fabrika.contract'
import app from '../app'
import { MAIL_API_URL, standInMail } from './mail-stand-in'

const postgres = await testDatabase({
	migrations: new URL('../../db/migrations/', import.meta.url),
	label: 'settings.test.ts',
})

/** This test issues no link: every membership request is refused. */
const refused = (): Promise<{ ok: false; reason: 'not_allowed' }> =>
	Promise.resolve({ ok: false, reason: 'not_allowed' })
const membership: IamMembershipRpc = {
	requestDelegation: refused,
	createScope: refused,
	assignMember: refused,
	revokeMember: refused,
	listMembers: refused,
	listAppMembers: refused,
	findMember: refused,
	issueLink: refused,
	revokeLink: refused,
}

const Mail = z.strictObject({
	to: z.string(),
	subject: z.string(),
	text: z.string(),
})

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, {
		database: postgres.database,
		files: new MemoryFileObjects(),
		membership,
		env: {
			MAIL_API_URL,
			MAIL_API_KEY: 'test',
			INTAKE_ORIGIN: 'https://intake.test',
			TURNSTILE_SECRET: 'test',
			TURNSTILE_SITE_KEY: 'test-site-key',
		},
	})
	let restore = () => {}
	afterEach(() => restore())

	describe('the test e-mail', () => {
		test("goes to the caller's own address, which the call does not name", async () => {
			const mail = standInMail()
			restore = mail.restore
			const lead = kit.testCaller([{ role: 'hr_lead' }], {
				email: 'Lead@Intake.test',
			})
			const api = createClient(contract, 'api', { fetch: kit.browser(lead) })
			expect(await api.settings.testMail()).toEqual({ sentTo: 'lead@intake.test' })
			expect(mail.sent.map((body) => Mail.parse(JSON.parse(body)).to)).toEqual([
				'lead@intake.test',
			])
		})
	})
}
```

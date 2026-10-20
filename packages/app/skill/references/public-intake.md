# references/public-intake.md — the public intake recipe

A visitor who has no account submits a form on a public page, with a photo from the phone's camera if they like,
confirms the e-mail address through a link, attaches files, and asks for a new link when the first one is lost. HR reviews the records, an HR lead edits the code lists of
open positions and of the reasons a decision records, HR exports every candidate with an audit row, and an HR person
checks the mail setup with a test e-mail to their own address. This file is an application of its own (`intake`); its
`package.json`, `tsconfig.json` and `src/app-kit.ts` are those of `app-setup.md`.

Every piece lets in someone who is not signed in, so ask the human before you build it, and say what each one lets the
visitor do. The visitor never reaches a handler without a credential:

1. **A public page** (`c.spa('/', { access: { public: true } })`) holds the form. It reads no data.
2. **A public procedure** (`access: { public: true }`) inserts one row into an application table and answers `{}`, for
   a new and a known address alike. It reads no existing row: a different answer for a known address would tell a
   stranger who registered.
3. **A cron job** claims the registrations, creates the record, issues a link bound to it (`issues`), and sends the
   e-mail through the installation's transport (`mailer: 'installation'`, `ctx.mail`). Each submission kicks it
   (`kicks: ['intake']`, `ctx.kick('intake')`), so it runs within seconds; its schedule is the recovery. It is the outbox recipe of
   `references/jobs.md`: bounded batches, each record its own work with an attempt count and a backoff, a dead state
   for a record that keeps failing, an idempotency key on the e-mail, and a retry only where the transport allows it.
4. **A link mount** serves the visitor's own record: `verify` and the record's files, under the link's key.
5. **A second public procedure** asks for a new link. The job revokes the old one and sends a new one, within a budget per address.

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
		'candidates.register': 'Record an anonymous registration or resend request',
		'positions.read': 'Read the open positions',
		'positions.manage': 'Edit the open positions',
		'reasons.manage': 'Edit the reasons a decision records',
		'exports.read': 'Read the log of candidate exports',
		'people.list': "List the application's people",
		'people.manage': "Grant and revoke the application's roles",
		'mail.test': 'Send yourself a test e-mail',
		'mail.send': 'Send the test e-mails people asked for',
	},
	roles: {
		hr: {
			grants: [
				'candidates.read',
				'candidates.review',
				'positions.read',
				'people.list',
				'mail.test',
			],
		},
		hr_lead: {
			grants: [
				'candidates.review',
				'candidates.export',
				'positions.read',
				'positions.manage',
				'reasons.manage',
				'exports.read',
				'people.list',
				'mail.test',
			],
		},
		hr_admin: {
			grants: [
				'candidates.read',
				'candidates.review',
				'positions.read',
				'people.list',
				'people.manage',
				'mail.test',
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
- The link's holder and the jobs get their actions from the link mount and each job's `actions`, not from a role.
  `mail.send` is no role's: only the job that sends the test e-mails holds it. `candidates.register` is no role's
  either: only the public procedures hold it.

```sql db/migrations/20261013090000_intake.sql
CREATE TYPE candidate_status AS ENUM ('new', 'screening', 'interview', 'hired', 'rejected');
CREATE TYPE link_state AS ENUM ('due', 'issued', 'sending', 'sent', 'failed');

-- The link delivery is the intake job's own state: each step is recorded here before the next effect starts.
-- attempts counts the failed attempts of the current delivery, last_failure names the step that failed, and
-- next_attempt_at is when the job may try it again; a delivery that failed five times is 'failed', which an
-- operator sees. 'sending' is a send whose outcome is not known yet. link_seal holds the issued link's URL,
-- sealed, until the e-mail is known sent, so a retry sends the same link under the same idempotency key.
CREATE TABLE candidates (
	id UUID PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	status candidate_status NOT NULL DEFAULT 'new',
	verified_at TIMESTAMPTZ,
	link_state link_state NOT NULL DEFAULT 'due',
	link_id TEXT,
	link_seal TEXT,
	revoke_link_id TEXT,
	sends INTEGER NOT NULL DEFAULT 0,
	window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_failure TEXT,
	photo UUID REFERENCES fabrika_files (id),
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
);
CREATE INDEX candidates_photo ON candidates (photo);

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

-- What the public procedures insert. A registration is a queue row the job claims: attempts counts its claims and
-- next_attempt_at is when it is due, NULL once done; last_failure names the step that failed last. photo holds the
-- file the visitor sent, or NULL. received_at keeps the time of the submission.
CREATE TABLE registrations (
	id UUID PRIMARY KEY,
	email TEXT NOT NULL,
	full_name TEXT NOT NULL,
	photo UUID REFERENCES fabrika_files (id),
	received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TIMESTAMPTZ DEFAULT now(),
	last_failure TEXT,
	version INTEGER NOT NULL
);
CREATE INDEX registrations_photo ON registrations (photo);
CREATE TABLE resend_requests (
	id UUID PRIMARY KEY,
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

-- The outbox of the test e-mails: the endpoint records one, and the testMails job sends it. 'sending' is a send
-- whose outcome is not known yet; next_attempt_at is when the job may try a failed one again.
CREATE TABLE test_mails (
	id UUID PRIMARY KEY,
	recipient TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'due' CONSTRAINT test_mails_state CHECK (state IN ('due', 'sending', 'sent', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_failure TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```sql db/migrations/20261013090100_attachments.sql
-- The files a link holder attaches to the candidate's record: one row per file, its reference in a file column.
CREATE TABLE candidate_files (
	id UUID PRIMARY KEY,
	candidate_id UUID NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
	file UUID NOT NULL REFERENCES fabrika_files (id),
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX candidate_files_candidate ON candidate_files (candidate_id);
CREATE INDEX candidate_files_file ON candidate_files (file);
```

A file column is a `UUID` that references `fabrika_files (id)`, with an index on it (`references/files.md`).

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
		files: { photo: 'photos' },
		columns: {
			status: { write: 'candidates.review' },
			photo: { write: 'candidates.attach' },
			link_state: { read: 'candidates.process' },
			link_id: { read: 'candidates.process' },
			link_seal: { read: 'candidates.process' },
			revoke_link_id: { read: 'candidates.process' },
			sends: { read: 'candidates.process' },
			window_started_at: { read: 'candidates.process' },
			attempts: { read: 'candidates.process' },
			next_attempt_at: { read: 'candidates.process' },
			last_failure: { read: 'candidates.process' },
		},
	},
	candidate_events: {
		scope: { child: 'candidates' },
		actions: { read: 'candidates.read', insert: 'candidates.review' },
		insert: ['status', 'note', 'reason_id'],
		createdBy: 'created_by',
	},
	candidate_files: {
		scope: { child: 'candidates' },
		actions: {
			read: 'candidates.read',
			insert: 'candidates.attach',
			delete: 'candidates.review',
		},
		insert: ['file'],
		files: { file: 'attachments' },
		createdBy: 'created_by',
	},
	registrations: {
		scope: { app: 'registrations of visitors, until the intake job takes them' },
		actions: {
			read: 'candidates.process',
			insert: 'candidates.register',
			update: 'candidates.process',
			delete: 'candidates.process',
		},
		insert: ['email', 'full_name', 'photo'],
		update: ['last_failure'],
		files: { photo: 'photos' },
		queue: { attempts: 'attempts', due: 'next_attempt_at', maxAttempts: 5 },
		version: 'version',
	},
	resend_requests: {
		scope: { app: 'requests for a new link, until the intake job takes them' },
		actions: {
			read: 'candidates.process',
			insert: 'candidates.register',
			delete: 'candidates.process',
		},
		insert: ['email'],
	},
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
	test_mails: {
		scope: { app: 'the test e-mails people asked for, until the job sends them' },
		actions: { read: 'mail.send', insert: 'mail.test' },
		insert: ['recipient'],
		createdBy: 'created_by',
	},
})
```

- `registrations` and `resend_requests` are what the public procedures insert, with `candidates.register`, which no
  role grants. A public procedure inserts and reads back nothing; only the job, with `candidates.process`, reads them.
- `queue` makes `registrations` a queue table: the job's `claim` leases due rows, counts `attempts`, and moves
  `next_attempt_at` by the backoff; a row claimed `maxAttempts` times stays, no longer due, for an operator.
- `files: { photo: 'photos' }` makes `photo` a file column of the kind `photos`. The claim reads it with the table's read
  action, so the job may write the same reference into `candidates.photo`, whose own write action is `candidates.attach`.
- `{ app: '<why>' }` is an application table: its rows belong to no candidate. An endpoint declared
  `access: { action, app: true }` reads and writes it through `ctx.db.app`, with the action the operation names. An
  endpoint `on`, `in` or `over` a candidate reads it, read-only and every row, where its action is the table's read
  action: `decide` reads `reasons` with `candidates.review`. A position or a reason is deactivated, never deleted, so
  neither table has a delete action. `candidate_exports` is appended with the export's own action, `candidates.export`,
  and read with `exports.read`. `test_mails` is appended with `mail.test` and read only by the job's `mail.send`.
- A registration records the time of the submission in a `DEFAULT now()` column (`received_at`). The job's own
  `now()` is later: seconds after a kick, up to a minute when the schedule recovers it.
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
import { settings, testMails } from './src/settings/endpoints'
import { visitors } from './src/visitors/endpoints'

export const contract = app.contract((c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	portal,
	api: c.rpc('/api', { visitors, candidates, positions, reasons, settings }),
	hr: c.spa('/hr', {
		dir: 'dist/hr',
		access: { action: 'candidates.read', over: 'candidate' },
	}),
	files: {
		attachments: c.files({
			types: ['application/pdf'],
			maxBytes: 10485760,
			scan: true,
		}),
		photos: c.files({
			types: ['image/jpeg', 'image/png', 'image/webp'],
			maxBytes: 15728640,
			scan: true,
		}),
	},
	jobs: { intake, testMails },
	health: c.health('/healthz'),
}))
```

```ts src/visitors/endpoints.ts
import { honeypot } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Register = z.strictObject({
	email: z.email().max(200),
	fullName: z.string().min(1).max(200),
	website: z.optional(z.string().max(200)),
	challengeToken: z.string().max(4096),
	photo: z.optional(file('photos')),
})
const Resend = z.strictObject({ email: z.email().max(200) })
const Empty = z.strictObject({})

/** Each inserts one row and answers the same, whatever the database holds: no answer tells who registered. */
export const visitors = app.group({}, (r) => ({
	register: r.mutation({
		input: Register,
		output: Empty,
		access: { public: true },
		actions: ['candidates.register'],
		admission: {
			challenge: {
				provider: 'turnstile',
				secret: 'TURNSTILE_SECRET',
				siteKey: 'TURNSTILE_SITE_KEY',
			},
			rate: { perClient: 100, perEndpoint: 100, bytesPerHour: 536870912 },
		},
		kicks: ['intake'],
	})
		.handle(async ({ input, ctx }) => {
			if (honeypot(input.website)) return {}
			await ctx.db.app('candidates.register').registrations.insert({
				email: input.email,
				full_name: input.fullName,
				photo: input.photo ?? null,
			})
			ctx.kick('intake')
			return {}
		}),
	resend: r.mutation({
		input: Resend,
		output: Empty,
		access: { public: true },
		actions: ['candidates.register'],
		limits: { maxBytes: 1024 },
		kicks: ['intake'],
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.app('candidates.register').resend_requests.insert({
				email: input.email,
			})
			ctx.kick('intake')
			return {}
		}),
}))
```

- **The public page.** `access: { public: true }` serves the SPA to anyone, without a token, and takes no other key.
  At `/` it answers every `GET` that no more specific endpoint serves, so the HR SPA (`/hr`) and the link's SPA (`/p`)
  keep their own. The approver sees it as "for anyone, without signing in". Put nothing on it that only members may
  read: the page calls only the public procedures.
- **A schema with a file field** stays in the slice's `endpoints.ts`, as `Register` does here. `src/schemas.ts` is
  loaded by the SPA and by `queries.ts`, and both are refused `@fabrika/app/contract`, where `file` comes from
  (`spa-server-import`, `layer-import`).
- **A public procedure** sits in a group with no callers (`app.group({}, …)`), declares `access: { public: true }`
  and the `actions` it holds, and is served at `POST /api/visitors.register`. `access` says anyone may call it;
  `actions` say what its handler may do. It runs as its own workload, with those actions only, whoever calls: the
  approver reads "anyone may call `api.visitors.register`; it runs with `candidates.register`".
- **What its handler reaches.** `ctx.db.app('<action>')` of an application table: an insert reads back nothing (the
  id is generated before the insert), a read needs the table's `read` action, and an update or a remove takes only a
  row id a verified signed token of the request carries (`references/endpoint.md`). It never locks or claims a row. It
  declares only `kicks` and `signs`: no `sql`, `unscoped`, `issues`, `connect`, `egress`, `binds` or mail. No role may
  grant its action, so a role change cannot widen it; a table staff read too lists both actions.
- **Constant work.** Answer and work the same for a new and a known visitor (`{}` here, one inserted row): an answer
  or a delay that depends on what exists tells a stranger who registered. The job decides later.
- **`ctx.client`** is `{ ip, userAgent }` as the proxy saw them, for consent evidence in a column of the row; `ip` is
  `null` on Zerops. Never decide on either.
- **Its abuse control.** `honeypot(input.website)` is true when the field the page hides is filled: answer the same
  and write no row. `admission.challenge` makes the framework verify the Turnstile token in the input field
  `challengeToken` before the handler runs (a failed token 400, an unreachable provider 503, no row either way) and adds
  Turnstile's origin to the CSP. `TURNSTILE_SECRET` is an application variable the human sets; without it the
  application does not boot. `siteKey` names the variable with the widget's public site key, which every SPA mount
  serves its pages; without it the application does not boot either. Another public value a page needs per
  environment (a link target) goes in the SPA mount's `browserConfig` list: `c.spa('/', { …, browserConfig: ['SIGNUP_URL'] })`. Both
  reach the page in `<prefix>/__fabrika-config.json` as `public: { <VARIABLE>: <value> }`, and the approver sees each
  name. Never name a secret there: the contract refuses a variable that is both.
  `admission.rate: { perClient, perEndpoint }` (per minute, 10 and 100 by default for a public mutation) answers 429
  past either limit; `null` turns one off. A public query counts nothing unless it declares a bucket, since each
  bucket is a database write per call: a page of twenty images costs no write. All public procedures of an instance
  hold at most a quarter of its database connections together; past that the answer is 503, and staff keep the rest.
  `limits: { maxBytes, timeoutMs }` bounds the body (64 KiB by default, plus each file field's files) and the handler
  (10 s). With file fields the JSON `input` part takes up to that limit, and the whole body, files included, stays
  within it.
- **The order of a public request**, each refusal with its answer: the origin rule (403), the in-flight share (503),
  every bucket (429), the bounded body and the strict input with its signed tokens (413, 400), the workload token (503
  while the platform's identity service is down), the challenge (400, 503 when the provider is unreachable), the staged file parts, then the handler, the
  commit and the kicks.
- **A form on someone else's page.** A page served from this application's own origin needs nothing. A partner's page
  or a separate marketing site needs `admission.origins`: `'listed'` for the origins an operator lists for the
  environment in Control, `'any'` for any site (an embeddable widget). Keep the honeypot, the challenge and the rate
  limit: `'any'` invites every site.
- **Zerops shares one client address.** Until the platform reads the visitor's address behind the Zerops balancer,
  every visitor counts as one client there, so `perClient` acts as a second per-endpoint limit: set it to the expected
  peak, never lower it to stop a flood. The challenge is the defense that does not depend on the address.
- **Counting clicks** on a public page has no primitive. The pattern is a public procedure without a challenge that
  inserts one row per click, posted with `fetch(…, { keepalive: true })`. Know both limits before you offer it:
  anyone can inflate the counts (the rate limits bound only how fast), and nothing reads the rows but a job you
  write. Ask the human first; usually the application should not count clicks.
- **Other origins** the pages load (an image host, an API the browser calls) go in the contract's `csp` section:
  `csp: { scriptSrc: [{ origin: 'https://…', purpose: '…' }] }`, beside `connectSrc`, `imgSrc`, `frameSrc`,
  `styleSrc`, `fontSrc` and `frameAncestors`: exact `https://` origins, at most 16 each. Each new origin is a widening the approver sees.
- **Scanned files.** A visitor's upload waits `quarantined` until ClamAV answers clean (`references/files.md`): a file
  answer is 409 until then. On Zerops the deploy service needs `verticalAutoscaling: { minRam: 2 }`.
- **A photo with the registration.** `photo: z.optional(file('photos'))` lets the visitor send one file beside the
  input; the client then sends the body as multipart. A public file field needs a challenge, `bytesPerHour` and a kind
  with `scan: true`, whose `types` and `maxBytes` bound the file. The handler writes the reference into
  `registrations.photo`, and the job writes the same reference into `candidates.photo`: the file is never copied. A
  file no column references any more (a known address, a registration an operator deleted) is deleted by the
  framework's sweep. A file the kind refuses (a type it does not admit, bytes that are not that type, too large) is
  415 or 413 after the challenge was spent, so the page checks the type and the size before it submits, and solves
  the challenge again after a refusal. The procedure's bodies take at most `bytesPerHour` in all (512 MiB here).
  Each request is charged its declared `Content-Length` before its body is read, which a browser sends for a form,
  or the whole body limit when it declares none, so with a 15 MiB photo about 34 maximal requests fit in an hour;
  past it the procedure answers 429 until the hour ends. Size the budget for the expected peak: a flood that spends
  it costs that hour's photos, not the storage.
- **The kick.** `kicks: ['intake']` and `ctx.kick('intake')` start a run of the job within seconds, once the row
  committed, under the job's own key. The visitor's answer never waits for the run. Kicks coalesce on the job's lease
  (at most one run and one pending, however many visitors submit), so a flood adds no work: the run still claims in
  batches of 50, within each address's budget. A kick carries nothing; the job reads its tables.

## The job: registration → record → link → e-mail

```ts src/links.ts
import { defineDeps } from '@fabrika/app/implement'

export interface Links {
	/** The address a link's path (`/p/#<key>`) is opened at: the application's public origin before it. */
	address(path: string): string
	/** Seals a link's URL for the row that waits to e-mail it; `open` reads it back. */
	seal(url: string): Promise<string>
	open(sealed: string): Promise<string>
}

/** Read when a link is used: the generated tests boot the application without its variables. */
const variable = (env: Readonly<Record<string, unknown>>, name: string) => {
	const value = env[name]
	if (typeof value !== 'string' || value === '') {
		throw new Error(`the application variable ${name} is not set`)
	}
	return value
}

export const links = defineDeps((env): Links => {
	// LINK_SEAL_KEY is 32 random bytes in base64: `openssl rand -base64 32`.
	const sealKey = () =>
		crypto.subtle.importKey(
			'raw',
			Buffer.from(variable(env, 'LINK_SEAL_KEY'), 'base64'),
			'AES-GCM',
			false,
			['encrypt', 'decrypt'],
		)
	return {
		address: (path) => `${variable(env, 'INTAKE_ORIGIN')}${path}`,
		async seal(url) {
			const iv = crypto.getRandomValues(new Uint8Array(12))
			const sealed = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				await sealKey(),
				new TextEncoder().encode(url),
			)
			return `${Buffer.from(iv).toString('base64')}.${
				Buffer.from(sealed).toString('base64')
			}`
		},
		async open(sealed) {
			const [iv = '', data = ''] = sealed.split('.')
			const url = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') },
				await sealKey(),
				Buffer.from(data, 'base64'),
			)
			return new TextDecoder().decode(url)
		},
	}
})
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { links } from './links'

export default serve(contract, { database: scoped(tables), deps: links })
```

```ts src/intake/endpoints.ts
import { EmailDeliveryError } from '@fabrika/app/implement'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { links } from '../links'

const Ask = z.strictObject({ email: z.string() })
const Id = z.strictObject({ id: z.string() })
const State = z.strictObject({ linkState: z.string() })
const Due = z.strictObject({
	id: z.string(),
	email: z.string(),
	linkState: z.enum(['due', 'issued', 'sending']),
	linkId: z.nullable(z.string()),
	linkSeal: z.nullable(z.string()),
	revokeLinkId: z.nullable(z.string()),
})

/** A link lives a week; an address gets at most three e-mails a day, failed deliveries included. */
const LINK_DAYS = 7
const SENDS_PER_DAY = 3
/** The records a run takes of each kind; the next run takes the rest. */
const BATCH = 50
/** A record that failed this many attempts is dead: the job leaves it to an operator. */
const MAX_ATTEMPTS = 5
/** How long one e-mail may take: far inside the attempt's timeout, so a hanging one is a counted failure. */
const SEND_TIMEOUT_MS = 10000

/** The step of a delivery that failed last: a fixed code, never the error's message. */
type Step = 'reserve' | 'revoke' | 'issue' | 'send'

export const intake = app.cron('* * * * *', {
	actions: [
		'candidates.process',
		'candidates.invite',
		'candidates.read',
		'candidates.verify',
		'candidates.attach',
	],
	retries: 0,
	sql: 'write',
	issues: 'portal',
	mailer: 'installation',
})
	.handle(async ({ ctx }) => {
		const urls = links.get()
		/**
		 * One record's work. A failure is the record's (`failed` counts it) and the run goes on
		 * with the next record, unless the attempt itself ended: the next run meets it as it is.
		 */
		const eachRecord = async (
			work: () => Promise<void>,
			failed: (error: unknown) => Promise<void>,
		): Promise<void> => {
			try {
				await work()
			} catch (error) {
				if (ctx.signal.aborted) throw error
				await failed(error)
			}
		}
		// A registration becomes a candidate once; the procedure told the visitor nothing either way.
		const claimed = await ctx.db.app('candidates.process').registrations.claim({
			limit: BATCH,
		})
		for (const row of claimed) {
			await eachRecord(() =>
				ctx.transaction(async (tx) => {
					const [created] = await tx.sql(Id)`
						insert into candidates (id, email, name, created_by, version)
						values (${crypto.randomUUID()}, ${row.email}, ${row.full_name},
							${ctx.principal.id}, 1)
						on conflict (email) do nothing
						returning id`
					// The photo's reference moves to the new candidate in this transaction; a known address gets none.
					if (created !== undefined && row.photo !== null) {
						const candidate = await tx.ref(
							'candidates.attach',
							'candidate',
							created.id,
						)
						await tx.db.on(candidate).update({ photo: row.photo }, {
							expectVersion: 1,
						})
					}
					await tx.db.on(row.ref).remove({ expectVersion: row.version })
				}), async () => {
				// The claim counted the attempt and set the backoff; the row keeps the step that failed.
				await ctx.transaction((tx) =>
					tx.db.on(row.ref).update({ last_failure: 'register' }, {
						expectVersion: row.version,
					})
				)
				if (row.attempts >= MAX_ATTEMPTS) {
					console.error(
						`intake: registration ${row.id} is dead; an operator decides`,
					)
				}
			})
		}
		// A resend supersedes the link of an unverified candidate, sent or dead, within its budget.
		await ctx.transaction(async (tx) => {
			const asks = await tx.sql(Ask)`
				delete from resend_requests where id in (
					select id from resend_requests order by received_at, id
					limit ${BATCH} for update skip locked)
				returning email`
			for (const ask of asks) {
				await tx.sql(Id)`
					update candidates
					set link_state = 'due', link_id = null, link_seal = null, attempts = 0,
						next_attempt_at = now(), revoke_link_id = coalesce(link_id, revoke_link_id)
					where email = ${ask.email} and verified_at is null
						and link_state in ('sent', 'failed')
						and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
					returning id`
			}
		})
		// An installation without a transport: the deliveries wait as they are and spend no attempt.
		if (!ctx.mail.available) return
		// Only a row whose budget has an e-mail left and whose backoff has passed: the others would
		// fill the batch and starve the rest.
		const due = await ctx.transaction((tx) =>
			tx.sql(Due)`
				select id, email, link_state, link_id, link_seal, revoke_link_id
				from candidates
				where link_state in ('due', 'issued', 'sending') and next_attempt_at <= now()
					and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				order by id limit ${BATCH}`
		)
		for (const candidate of due) {
			// A send whose outcome is unknown goes out again only over a transport that deduplicates its key.
			if (candidate.linkState === 'sending' && !ctx.mail.capabilities.idempotent) {
				await ctx.transaction((tx) =>
					tx.sql(Id)`
						update candidates set link_state = 'failed', link_seal = null, last_failure = 'send'
						where id = ${candidate.id} and link_state = 'sending' returning id`
				)
				console.error(
					`intake: the delivery to ${candidate.id} may have been sent; it is dead, and a resend gives a new link`,
				)
				continue
			}
			let step: Step = 'reserve'
			await eachRecord(async () => {
				// The e-mail and the wait are charged before any effect, so a run that dies mid-send waits too;
				// a row other work holds waits for a later run.
				const reserved = await ctx.transaction((tx) =>
					tx.sql(Id)`
						update candidates set
							next_attempt_at = now()
								+ least(interval '1 minute' * power(2, attempts), interval '1 hour'),
							sends = case when window_started_at < now() - interval '1 day' then 1 else sends + 1 end,
							window_started_at = case when window_started_at < now() - interval '1 day'
								then now() else window_started_at end
						where id = (
							select id from candidates where id = ${candidate.id}
								and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
							for update skip locked)
						returning id`
				)
				if (reserved.length === 0) return
				// An issued link may already have been e-mailed: it goes out again, never replaced.
				const issuedBefore = candidate.linkState !== 'due'
						&& candidate.linkId !== null && candidate.linkSeal !== null
					? { id: candidate.linkId, seal: candidate.linkSeal }
					: null
				const superseded = candidate.revokeLinkId
					?? (issuedBefore === null ? candidate.linkId : null)
				if (superseded !== null) {
					step = 'revoke'
					ctx.signal.throwIfAborted()
					await ctx.links.revoke(superseded)
					await ctx.transaction((tx) =>
						tx.sql(Id)`
							update candidates set revoke_link_id = null
							where id = ${candidate.id} returning id`
					)
				}
				let link: { readonly id: string; readonly url: string }
				if (issuedBefore !== null) {
					link = { id: issuedBefore.id, url: await urls.open(issuedBefore.seal) }
				} else {
					step = 'issue'
					ctx.signal.throwIfAborted()
					const ref = await ctx.ref('candidates.invite', 'candidate', candidate.id)
					const issued = await ctx.links.issue(ref, {
						mount: 'portal',
						days: LINK_DAYS,
					})
					const sealed = await urls.seal(issued.url)
					await ctx.transaction((tx) =>
						tx.sql(Id)`
							update candidates
							set link_state = 'issued', link_id = ${issued.id}, link_seal = ${sealed}
							where id = ${candidate.id} returning id`
					)
					link = issued
				}
				step = 'send'
				ctx.signal.throwIfAborted()
				await ctx.transaction((tx) =>
					tx.sql(Id)`
						update candidates set link_state = 'sending'
						where id = ${candidate.id} and link_id = ${link.id} returning id`
				)
				await ctx.mail.send({
					to: candidate.email,
					subject: 'Confirm your address',
					text: `Open ${urls.address(link.url)} to confirm your address.`,
					idempotencyKey: `intake-link-${link.id}`,
				}, AbortSignal.timeout(SEND_TIMEOUT_MS))
				await ctx.transaction((tx) =>
					tx.sql(Id)`
						update candidates
						set link_state = 'sent', link_seal = null, attempts = 0, last_failure = null
						where id = ${candidate.id} and link_id = ${link.id} returning id`
				)
			}, async (error) => {
				// The transport says whether a send may go again: a refused recipient, or an unknown outcome
				// over a transport that does not deduplicate, ends the delivery now.
				const final = error instanceof EmailDeliveryError
					&& !ctx.mail.mayRetry(error)
				const notSent = error instanceof EmailDeliveryError
					&& error.outcome === 'not_sent'
				const [counted] = await ctx.transaction((tx) =>
					tx.sql(State)`
						update candidates
						set attempts = attempts + 1, last_failure = ${step},
							next_attempt_at = now()
								+ least(interval '1 minute' * power(2, attempts), interval '1 hour'),
							link_state = case
								when ${final} or attempts + 1 >= ${MAX_ATTEMPTS} then 'failed'
								when link_state = 'sending' and ${notSent} then 'issued'
								else link_state end,
							link_seal = case when ${final} or attempts + 1 >= ${MAX_ATTEMPTS}
								then null else link_seal end
						where id = ${candidate.id} returning link_state`
				)
				if (counted?.linkState === 'failed') {
					console.error(
						`intake: the delivery to ${candidate.id} is dead; an operator decides`,
					)
				}
			})
		}
	})
```

The job keeps eight invariants. Keep them when you change it:

- **Each record is its own work, in bounded batches.** A run takes at most 50 registrations, oldest first, and 50 due
  deliveries; the next run takes the rest. Each record's work runs in `eachRecord`: a failure (a row the insert refuses,
  a refused recipient, an e-mail past `SEND_TIMEOUT_MS`, IAM down) adds one to the record's `attempts`, keeps the step
  in `last_failure`, and the run goes on with the next record, so one bad record stops nothing else. A record that failed `MAX_ATTEMPTS` times is
  dead: a registration stays in its table, no longer due, a delivery is `failed`; the job logs each once, by
  id, never by address. An operator decides: fix the row, or delete it. A resend revives a `failed` delivery, within
  the budget. A failure of an ended attempt (`ctx.signal` aborted) is the attempt's, not the record's: it is thrown,
  and the next run meets the record as it is. So each e-mail gets its own deadline inside the attempt's: `ctx.mail.send`
  always takes the attempt's `ctx.signal`, and the job adds `AbortSignal.timeout(SEND_TIMEOUT_MS)`. A recipient whose
  e-mail hangs fails its own attempt and reaches the dead state, and every later record of the run still goes.
- **A failed delivery waits before the next try.** Its failure sets `next_attempt_at` one minute ahead, doubled per
  attempt up to an hour, and the batch takes only a row whose time has come. Kicks can start several runs within
  seconds; without the wait, a short provider outage would spend every attempt of a delivery at once.
- **The transport decides whether a send goes again.** `ctx.mail.mayRetry(error)` is false for a refused recipient
  or configuration, and for an outcome that is unknown over a transport that does not deduplicate a key
  (`ctx.mail.capabilities`): such a delivery is dead at once, and a resend gives it a new link. The row is `sending` while its e-mail is out: a run that finds a `sending` row (a crash, a
  lost answer) sends it again only when `ctx.mail.capabilities.idempotent` holds, and otherwise leaves it dead for a
  person, because the e-mail may have arrived. A failure the transport says did not send it (`outcome: 'not_sent'`)
  returns the row to `issued`.
- **A record is claimed where it is consumed.** `claim` leases each registration in a short transaction of its own and
  skips a row other work holds; the job then removes it and inserts the candidate in one transaction, under the
  version the claim answered. A failure leaves the row due again after the claim's backoff. The resend batch is `for update skip locked` in the delete that
  takes it, and the reservation skips a candidate row other work holds. A row someone else locks (an operator's
  session, an HR request) waits for a later run and blocks nothing behind it.
- **The budget is charged first.** Each delivery reserves one e-mail of the address's daily budget, in its own
  transaction, before any effect, and sets its `next_attempt_at` there too. A delivery that fails after the e-mail
  left is still counted, so a provider that times out cannot make the job mail one address without end, and a run
  that dies mid-send leaves a row that waits out its backoff instead of going again at the next kick. Only a row with an e-mail left is selected for the batch
  of 50, so spent rows never crowd out the others; the reservation checks the budget again in its own transaction.
- **Each step is recorded before the next effect.** Revoke a superseded link, then record it; issue, then record the
  link's id and its sealed URL (`issued`); record `sending`, send, then record `sent`. A run that stops anywhere (a crash, a refused
  e-mail, IAM down) is finished by the next run its budget allows.
- **The link is the delivery's identity.** Its e-mail's idempotency key is `intake-link-<link id>`; `ctx.mail` puts
  the application environment's prefix before it, so no other application on the transport shares it. Until the
  e-mail is known sent, the row keeps the link's URL in `link_seal`, sealed with AES-GCM under `LINK_SEAL_KEY`, never
  in plain text, and cleared once it is `sent` or dead. An `issued` or `sending` row is sent again from it: the same
  message under the same key, which an idempotent transport sends once, so an answer or a commit lost after the
  provider took the e-mail sends no second one, and the link the visitor got still works. Only a resend replaces a link. IAM's `issue` takes
  no key: a run that stops between the issue and its record leaves a link no row names, whose key only the job saw
  and which expires with its `days`.
- **An effect starts only while the attempt is live.** `ctx.signal.throwIfAborted()` runs before each IAM call and the
  e-mail, and `ctx.mail.send` aborts with `ctx.signal`. `ctx.mail`, like `ctx.links`, refuses to send for an ended
  attempt. The runner aborts a timed-out attempt before the next one starts, so no
  effect of a stale attempt follows the next one's.

More on the job:

- **`issues: 'portal'`** gives the job `ctx.links.issue(ref, { mount, days })` and `ctx.links.revoke(id)` for the
  links it issued. Its `actions` must hold the mount's `issuedBy` and every grant of the mount, or the contract is
  refused: IAM lets an issuer delegate only what it holds. The link is bound to one candidate (the `Ref`), and the
  approver sees the job's `issues` marked "needs closer review".
- **`sql: 'write'`** is the declared reach for the candidate's insert (`on conflict (email) do nothing`), the resend
  requests and the delivery state. A file column is written only through `tx.db`, so the photo's reference goes into
  `candidates.photo` through `tx.db.on(ref).update`. **A job writes no scope fragment**: it is application-wide, so
  `tx.sql.scope` of its `Within` is every row, and an application table has no scope at all.
- **The latency.** The procedures' kick starts a run within seconds of a submission, so the e-mail leaves seconds later,
  while the address has an e-mail of its daily budget left; a spent one waits until a day after the window's first
  e-mail. Keep the schedule (`* * * * *`): it is the recovery path. A kicked run that dies (a crash, a deploy, a
  timeout) leaves its rows, and the next scheduled run finishes them, within a minute. `retries: 0`: that run is the
  retry. A failed run leaves a pending kick to the schedule too.
- **A revoked link** still works until the token the proxy holds for it expires, at most 5 minutes. Revocation is the
  stop at IAM; it is not instant.
- **`mailer: 'installation'`** gives the job `ctx.mail`, over the installation's mail transport: the application holds
  no provider key and no transport code, and the approver sees the declaration marked "needs closer review". An
  installation without a transport still deploys it: `ctx.mail.available` is false, and the job delivers nothing and
  leaves every delivery as it is, so no attempt is spent. They leave on the first run after the operator adds a
  transport and the application is deployed again. An endpoint has no `ctx.mail`.
- The link's address and its seal come from `deps` (`src/links.ts`), built from application variables the human sets
  (`INTAKE_ORIGIN`, and `LINK_SEAL_KEY`: `openssl rand -base64 32`). A new `LINK_SEAL_KEY` makes the rows waiting with
  a sealed link fail their `open` until they are dead; a resend gives each a new link. `link.url` is `/p/#<key>`: the
  key is in the fragment, which no server and no `Referer` sees.

## The visitor's link: verify once, attach files

```ts src/portal/endpoints.ts
import { ConflictError, NotFoundError } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Me, Verified } from '../schemas'

const Attach = z.strictObject({ file: file('attachments') })
const Attached = z.strictObject({ id: z.uuid() })
const Document = z.strictObject({ id: z.uuid() })
const Documents = z.strictObject({
	items: z.array(z.strictObject({
		id: z.uuid(),
		name: z.nullable(z.string()),
		status: z.string(),
	})),
})

/** The files one candidate keeps. */
const MAX_FILES = 5

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
		attach: l.mutation({
			input: Attach,
			output: Attached,
			access: { action: 'candidates.attach' },
		})
			.handle(async ({ input, ctx }) => {
				// The lock serializes two uploads of one candidate, so the count holds.
				await ctx.db.target.getForUpdate()
				const held = await ctx.db.target.candidate_files.list({ limit: MAX_FILES })
				if (held.items.length >= MAX_FILES) {
					throw new ConflictError(`a candidate keeps at most ${MAX_FILES} files`)
				}
				await ctx.db.target.candidate_files.insert({ file: input.file })
				return { id: input.file.id }
			}),
		documents: l.query({
			output: Documents,
			access: { action: 'candidates.read' },
		})
			.handle(async ({ ctx }) => ({
				items: (await ctx.db.target.candidate_files.list()).items.map((row) => ({
					id: row.file.id,
					name: row.file.name,
					status: row.file.status,
				})),
			})),
		document: l.query({
			input: Document,
			output: file('attachments'),
			access: { action: 'candidates.read' },
		})
			.handle(async ({ input, ctx }) => {
				const rows = (await ctx.db.target.candidate_files.list()).items
				const row = rows.find((item) => item.file.id === input.id)
				if (row === undefined) throw new NotFoundError('no such document')
				return row.file
			}),
	}),
})
```

- **Single use is the application's state.** `verify` sets `verified_at` once, under `getForUpdate`; a second call
  answers the same time. IAM counts no uses: the proxy honors a token it holds without asking IAM.
- A link procedure acts on the link's own object: no `from`, no id in the input. A key of another candidate reaches
  only that candidate's record, and a key whose candidate is gone answers 404.
- A file is a value in `candidate_files.file`: `attach` writes the uploaded reference with `candidates.attach`,
  `documents` lists the rows with each file's `name` and `status`, and `document` answers one file
  (`output: file('attachments')`), all for the link's candidate only: another candidate's file id answers 404. The
  holder's client calls `portal.attach({ file })` and `download(portal.document, { id })`; a key never goes into a
  URL. HR reaches the same rows through procedures of its own with `candidates.read`. A link mount reaches only the
  files its own procedures answer.

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
	if (portal === null) return 'This link holds no key.'
	try {
		await portal.attach({ file })
		return 'Received: it is being checked.'
	} catch (error) {
		return error instanceof RpcError ? `Refused: ${error.type}` : 'Failed'
	}
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

The public page calls the public procedure through the typed client, like any other. An input with a file is sent
as a multipart body, and one without a file as JSON.

```ts web/site/register.ts
import { createClient } from '@fabrika/app/client'
import { contract } from '../../fabrika.contract'

const api = createClient(contract, 'api')

/** What the `photos` kind admits; the page checks it before it spends the challenge. */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const PHOTO_MAX_BYTES = 15728640

export const register = async (
	form: HTMLFormElement,
	challengeToken: string,
): Promise<boolean> => {
	const data = new FormData(form)
	const field = (name: string) => {
		const value = data.get(name)
		return typeof value === 'string' ? value : ''
	}
	// <input type="file" name="photo" accept="image/*" capture="environment">; an empty one sends nothing.
	const sent = data.get('photo')
	const photo = sent instanceof File && sent.size > 0 ? sent : undefined
	if (
		photo !== undefined
		&& (!PHOTO_TYPES.includes(photo.type) || photo.size > PHOTO_MAX_BYTES)
	) {
		return false
	}
	try {
		await api.visitors.register({
			email: field('email'),
			fullName: field('full_name'),
			website: field('website'),
			challengeToken,
			photo,
		})
		return true
	} catch {
		return false
	}
}
```

- The page renders the Turnstile widget with the site key `siteKey()` reads and `action` set to the procedure's
  endpoint id with `_` for `.` (`api_visitors_register`), and passes the widget's token. Say "check your inbox" on success whatever the address was.
- The resend form calls `api.visitors.resend({ email })`. It answers the same for an unknown, a verified and a
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
import {
	BadRequestError,
	ConflictError,
	fromPage,
	fromRow,
	NotFoundError,
} from '@fabrika/app'
import { attachment, file } from '@fabrika/app/contract'
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
const FileOf = z.strictObject({ id: z.uuid(), file: z.uuid() })
const Files = z.strictObject({
	items: z.array(z.strictObject({
		id: z.uuid(),
		name: z.nullable(z.string()),
		status: z.string(),
	})),
})
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
	files: r.query({
		input: ById,
		output: Files,
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.target.candidate_files.list()).items.map((row) => ({
				id: row.file.id,
				name: row.file.name,
				status: row.file.status,
			})),
		})),
	file: r.query({
		input: FileOf,
		output: file('attachments'),
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const rows = (await ctx.db.target.candidate_files.list()).items
			const row = rows.find((item) => item.file.id === input.file)
			if (row === undefined) throw new NotFoundError('no such file')
			return row.file
		}),
	photo: r.query({
		input: ById,
		output: file('photos'),
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ ctx }) => {
			const { photo } = await ctx.db.target.get()
			if (photo === null) throw new NotFoundError('the candidate sent no photo')
			return photo
		}),
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

- **HR's files.** `files`, `file` and `photo` serve the candidate's files to a holder of `candidates.read`. A file
  query is a `GET`, so the HR page links it for its signed-in session: `api.candidates.photo.url({ id })` in an
  `<img src>`, `api.candidates.file.url({ id, file })` in an `<a download>`.
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
import { EmailDeliveryError } from '@fabrika/app/implement'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Queued = z.strictObject({ queuedFor: z.string() })
const Id = z.strictObject({ id: z.string() })
const Claimed = z.strictObject({
	recipient: z.string(),
	state: z.string(),
	attempts: z.number(),
})

/** The test e-mails a run takes; the next run takes the rest. */
const BATCH = 50
/** A test e-mail that failed this many attempts is dead: the job leaves it to an operator. */
const MAX_ATTEMPTS = 5
/** How long one e-mail may take: far inside the attempt's timeout. */
const SEND_TIMEOUT_MS = 10000

export const settings = app.group({ callers: ['human'] }, (r) => ({
	/** Records a test e-mail to the caller; the job it kicks sends it within seconds. */
	testMail: r.mutation({
		output: Queued,
		access: { action: 'mail.test', app: true },
		kicks: ['testMails'],
	})
		.handle(async ({ ctx }) => {
			const to = ctx.principal.email
			await ctx.db.app.test_mails.insert({ recipient: to })
			ctx.kick('testMails')
			return { queuedFor: to }
		}),
}))

/** A failed send: dead, due again when it did not leave, or `sending` when it may have. */
const stateAfter = (
	failure: unknown,
	mayRetry: boolean,
	attempts: number,
): 'due' | 'sending' | 'failed' => {
	if (!mayRetry || attempts >= MAX_ATTEMPTS) return 'failed'
	return failure instanceof EmailDeliveryError && failure.outcome === 'not_sent'
		? 'due'
		: 'sending'
}

export const testMails = app.cron('* * * * *', {
	actions: ['mail.send'],
	retries: 0,
	sql: 'write',
	mailer: 'installation',
})
	.handle(async ({ ctx }) => {
		// An installation without a transport: the rows wait as they are and spend no attempt.
		if (!ctx.mail.available) return
		const due = await ctx.transaction((tx) =>
			tx.sql(Id)`
				select id from test_mails
				where state in ('due', 'sending') and next_attempt_at <= now()
				order by created_at, id limit ${BATCH}`
		)
		for (const { id } of due) {
			// Claimed and charged before the send: a failure waits out its backoff, however many kicks arrive.
			const mail = await ctx.transaction(async (tx) => {
				const [row] = await tx.sql(Claimed)`
					select recipient, state, attempts from test_mails
					where id = ${id} and state in ('due', 'sending') and next_attempt_at <= now()
					for update skip locked`
				if (row === undefined) return null
				// A send whose outcome is unknown goes out again only over a transport that deduplicates its key.
				if (row.state === 'sending' && !ctx.mail.capabilities.idempotent) {
					await tx.sql(Id)`
						update test_mails set state = 'failed', last_failure = 'unknown'
						where id = ${id} returning id`
					console.error(
						`intake: test e-mail ${id} may have been sent; an operator decides`,
					)
					return null
				}
				await tx.sql(Id)`
					update test_mails set state = 'sending', attempts = attempts + 1,
						next_attempt_at = now()
							+ least(interval '1 minute' * power(2, attempts), interval '1 hour')
					where id = ${id} returning id`
				return { recipient: row.recipient, attempts: row.attempts + 1 }
			})
			if (mail === null) continue
			let failure: unknown = null
			try {
				ctx.signal.throwIfAborted()
				await ctx.mail.send({
					to: mail.recipient,
					subject: 'A test e-mail from the intake',
					text: 'The intake can send you e-mail.',
					idempotencyKey: `test-mail-${id}`,
				}, AbortSignal.timeout(SEND_TIMEOUT_MS))
			} catch (error) {
				if (ctx.signal.aborted) throw error
				failure = error
			}
			if (failure === null) {
				await ctx.transaction((tx) =>
					tx.sql(Id)`
						update test_mails set state = 'sent', last_failure = null
						where id = ${id} returning id`
				)
				continue
			}
			const state = stateAfter(failure, ctx.mail.mayRetry(failure), mail.attempts)
			const code = failure instanceof EmailDeliveryError ? failure.code : 'send'
			await ctx.transaction((tx) =>
				tx.sql(Id)`
					update test_mails set state = ${state}, last_failure = ${code}
					where id = ${id} returning id`
			)
			if (state === 'failed') {
				console.error(`intake: test e-mail ${id} is dead; an operator decides`)
			}
		}
	})
```

- **The address is the caller's, from the token.** `ctx.principal.email` is the mailbox IAM recorded for the person
  (lower-cased), so the input has no address field. IAM recorded it; how far it checked that the person controls it is
  its login method's (an operator may accept an IdP's unverified address). An input that named one would let anyone
  who holds `mail.test` mail any address past every consent the application asks for. Never take a recipient from the
  input for "send it to me".
- **The endpoint sends nothing.** It has no `ctx.mail`: it records the e-mail in `test_mails` in its own transaction,
  and `kicks: ['testMails']` with `ctx.kick('testMails')` starts the job once that transaction committed. The person's answer does not wait for the
  run; the e-mail leaves seconds later. The schedule (`* * * * *`) sends what a kicked run left behind. The generated
  tests cover the endpoint like any `app` endpoint: a global holder of `mail.test` reaches it, a holder in one scope
  gets 403.
- **The job is the outbox recipe in small** (`references/jobs.md`): bounded batches; each row claimed
  `for update skip locked` and charged (`attempts`, `next_attempt_at` one minute ahead, doubled per attempt up to an
  hour) before the send, so kicks cannot spend its attempts within seconds; the key `test-mail-<id>`; `sending` while
  the e-mail is out; and a retry only where `ctx.mail.mayRetry(error)` allows it. A row found `sending` (a crash, a
  lost answer) goes out again only over a transport that deduplicates its key, and is otherwise dead, because the
  e-mail may have arrived. `last_failure` keeps the transport's fixed code (`provider_rejected`), never its message.
- The page shows the button only to someone who holds `mail.test`: its SPA reads `/hr/__fabrika-me.json`
  (`references/app-setup.md`).

## Tests

- The generated tests cover HR's endpoints, the files and the link's procedures: the endpoint access kit asks each
  link procedure as a holder of a key bound to a seeded candidate. Each `app` endpoint gets two cases: a holder of
  its action in one candidate only is 403, and a global holder reaches it. `positions`, `reasons`,
  `candidate_exports` and `test_mails` get a policy probe of their actions, held globally and in one scope, and of a scoped site that
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
  answers `issueLink` and `revokeLink`. A test of a public procedure with a challenge passes `env: {
  TURNSTILE_SECRET: '…', TURNSTILE_SITE_KEY: '…' }` and `challengeFetch`, a stand-in for Turnstile's answer, to `testKit`, and a fresh
  `challengeToken` with each submission: a token is single use. A submission with a photo goes through the typed
  client over `kit.fetch`, and needs `files: new MemoryFileObjects()` in `testKit`; `kit.runJob('intake')` then
  writes the photo's reference into the candidate, and the scan job (`FILE_SCAN_JOB`, with a `scanner`) makes it
  readable. Test the refusals beside the success: no or a failed token, a filled honeypot, a file too large or of
  another type, a page on another origin; each keeps nothing. Test each stop of a delivery (a refused e-mail, IAM
  down, a crash after each step, an answer lost after the provider took the e-mail): the next run must leave exactly
  one live, e-mailed link and the transport one message per key. Test a bad record beside good ones too: a
  registration the insert refuses and a recipient whose e-mail hangs end dead after `MAX_ATTEMPTS` runs, a recipient
  the transport refuses ends dead at once, and every other record is delivered and every run succeeds; a
  registration another session locks waits. A failed delivery waits for its `next_attempt_at`: a test that runs the
  job again moves that column into the past first, as an operator's repair would.
- A test that calls a mutation that kicks (`kicks`, `ctx.kick`) starts the job too, and the kicked run may start
  at once: arm a fault before the call, never between it and the run. `kit.drain()` waits for the kicked runs, and
  `kit.runJob('intake')` first waits for them, then runs once.
- The mail transport is the kit's stand-in: `kit.mail`, a `MemoryEmailSender` that takes every message a job sends
  through `ctx.mail`, once per key as an idempotent provider does. `kit.mail.accepted` is what reached the inbox and
  `kit.mail.handoffs` every send with its answer. `refuse(code?)`, `unavailable()`, `unreachable()`, `loseAnswers(n)`
  and `during(hook)` inject a failure until `heal()`. A message carries the key the transport got,
  `transportMailKey(kit.mailKeyScope, key)`. A transport that does not deduplicate is
  `testKit(app, { mail: new MemoryEmailSender({ capabilities: { idempotent: false, confirmation: 'queued' } }) })`:
  test there that a lost answer leaves a delivery dead, never sent twice. `mail: 'none'` is an installation without a
  transport: test that its run leaves the rows queued, and that a kit with a transport over the same database sends
  them. One served application boots one kit, so the second kit serves the contract again (`serve(contract, { … })`,
  as `src/app.ts` does).
- `LINK_SEAL_KEY` and `INTAKE_ORIGIN` are application variables: a test of the job passes them in `testKit`'s `env`,
  `LINK_SEAL_KEY` as `Buffer.alloc(32, 1).toString('base64')`.
- The test e-mail goes to the caller's own address: the test sends no address and reads the recipient from `kit.mail`.

```ts src/__tests__/settings.test.ts
import { createClient } from '@fabrika/app/client'
import { serve } from '@fabrika/app/implement'
import {
	type IamMembershipRpc,
	testKit,
	transportMailKey,
} from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { contract } from '../../fabrika.contract'
import app from '../app'
import { tables } from '../db/tables'
import { links } from '../links'

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

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, {
		database: postgres.database,
		files: new MemoryFileObjects(),
		membership,
		env: { TURNSTILE_SECRET: 'test', TURNSTILE_SITE_KEY: 'test-site-key' },
	})
	afterEach(() => kit.mail.heal())
	const sentTo = (address: string) =>
		kit.mail.handoffs.filter((handoff) => handoff.message.to === address)

	describe('the test e-mail', () => {
		test("goes to the caller's own address, which the call does not name", async () => {
			const lead = kit.testCaller([{ role: 'hr_lead' }], {
				email: 'Lead@Intake.test',
			})
			const api = createClient(contract, 'api', { fetch: kit.browser(lead) })
			expect(await api.settings.testMail()).toEqual({
				queuedFor: 'lead@intake.test',
			})
			// The mutation kicked the job: the e-mail leaves without a scheduled run.
			await kit.drain()
			const [sent] = sentTo('lead@intake.test')
			expect(sent?.answer).toBe('accepted')
			expect(sent?.message.idempotencyKey)
				.toStartWith(transportMailKey(kit.mailKeyScope, 'test-mail-'))
		})

		test('waits while the installation has no mail, and leaves once it has a transport', async () => {
			// One served application boots one kit: this one serves the contract again.
			const noMail = testKit(
				serve(contract, { database: scoped(tables), deps: links }),
				{
					database: postgres.database,
					files: new MemoryFileObjects(),
					membership,
					env: { TURNSTILE_SECRET: 'test', TURNSTILE_SITE_KEY: 'test-site-key' },
					mail: 'none',
				},
			)
			const admin = noMail.testCaller([{ role: 'hr_admin' }], {
				email: 'waiting@intake.test',
			})
			const api = createClient(contract, 'api', { fetch: noMail.browser(admin) })
			await api.settings.testMail()
			await noMail.drain()
			expect(await noMail.runJob('testMails')).toEqual({
				status: 'succeeded',
				attempts: 1,
			})
			// The same database under a transport: the row that waited leaves.
			expect(await kit.runJob('testMails')).toEqual({
				status: 'succeeded',
				attempts: 1,
			})
			expect(sentTo('waiting@intake.test').map((handoff) => handoff.answer))
				.toEqual(['accepted'])
		})

		test('one the transport refuses is dead: no later run sends it', async () => {
			// Armed before the call: the kicked run may start at once.
			kit.mail.refuse('provider_rejected')
			const admin = kit.testCaller([{ role: 'hr_admin' }], {
				email: 'admin@intake.test',
			})
			const api = createClient(contract, 'api', { fetch: kit.browser(admin) })
			await api.settings.testMail()
			await kit.drain()
			kit.mail.heal()
			expect(await kit.runJob('testMails')).toEqual({
				status: 'succeeded',
				attempts: 1,
			})
			expect(sentTo('admin@intake.test').map((handoff) => handoff.answer))
				.toEqual(['provider_rejected'])
		})
	})
}
```

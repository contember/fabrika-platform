# references/spa.md — the SPA: React, the hooks over the typed client, and the component kit

The SPA of the paved road is React. `@fabrika/app/react` runs the typed client's calls and caches their answers;
`@fabrika/ui` holds the screens' components, a router and one theme stylesheet. Build every screen from them. Never
write a DOM element builder, a router, a cache or a component set of your own: when the kit lacks a piece, compose it
from the kit's components and the theme's tokens in the application's own stylesheet. `app-setup.md` shows the
dependencies, `tsconfig.json` (`"jsx": "react-jsx"`) and `build-web.ts`.

| Module                       | Holds                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fabrika/app/client`        | `createClient(contract, 'api')`: one function per procedure, its answer parsed by the output schema                                                       |
| `@fabrika/app/react`         | `FabrikaProvider`, `useQuery`, `useInfiniteQuery`, `useMutation`, `useAction`, `useDownload`, `useInvalidate`, `skip`, `useCaller`, `Can`, `FabrikaError` |
| `@fabrika/app/react/testing` | `installDom`, `type`, `controlByLabel`, `waitForText`: a screen test's DOM and typing                                                                     |
| `@fabrika/ui`                | the components below, `createRouter`, and `@fabrika/ui/styles.css`                                                                                        |

## The provider and the routes

```ts web/routes.ts
import { createRouter } from '@fabrika/ui'

export const { Router, Link, href, navigate, useRoute } = createRouter({
	mine: '/',
	project: '/orgs/:orgId/projects/:projectId',
	task: '/tasks/:id',
})
```

```tsx web/start.tsx
import '@fabrika/ui/styles.css'
import './app.css'
import { FabrikaProvider, useCaller } from '@fabrika/app/react'
import { AppShell, EmptyState, ToastProvider } from '@fabrika/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import { MyTasks } from './mine'
import { ProjectTasks } from './project'
import { href, Router, useRoute } from './routes'
import { TaskView } from './task'

function Screen() {
	const route = useRoute()
	switch (route?.name) {
		case 'mine':
			return <MyTasks />
		case 'project':
			return (
				<ProjectTasks
					orgId={route.params.orgId}
					projectId={route.params.projectId}
				/>
			)
		case 'task':
			return <TaskView key={route.params.id} id={route.params.id} />
		case undefined:
			return (
				<EmptyState title="Nothing here" text="This address names no screen." />
			)
	}
}

function Shell() {
	const route = useRoute()
	const caller = useCaller()
	return (
		<AppShell
			brand="Tasks"
			nav={[{
				label: 'My tasks',
				href: href('mine'),
				active: route?.name === 'mine',
			}]}
			user={caller?.label ?? caller?.email}
		>
			<Screen />
		</AppShell>
	)
}

const root = document.getElementById('root')
if (root !== null) {
	createRoot(root).render(
		<StrictMode>
			<FabrikaProvider clients={[api]}>
				<ToastProvider>
					<Router>
						<Shell />
					</Router>
				</ToastProvider>
			</FabrikaProvider>
		</StrictMode>,
	)
}
```

- `FabrikaProvider` holds the clients of the mounts the page calls. A hook takes a procedure of a client
  (`api.tasks.get`) as the typed name of the call and runs it on the provider's client of that mount; a test hands the
  provider a client over the test kit instead (below). An SPA mounted under a prefix passes it: `spa="/app"`. Its bare
  prefix (`/app`) redirects to `/app/`, so a link may name either.
- `createRouter` answers typed paths: `href('task', { id })`, `navigate('project', { orgId, projectId })`, `<Link
  to="task" params={{ id }}>`, and `useRoute()`, the match or `null`. `<Router>` makes every plain `<a href>` under the
  SPA navigate without a reload: the kit's components render links that way. Pass `{ base: '/app' }` for a prefix.
- `ToastProvider` once at the root; `useToast().show({ tone: 'success', message })` anywhere below it.

## Reading: useQuery and useInfiniteQuery

```ts web/api.ts
import { createClient } from '@fabrika/app/client'
import type { PageAnswer, ProcedureResult } from '@fabrika/app/react'
import { contract } from '../fabrika.contract'

export const api = createClient(contract, 'api', { bounceOnAuth: true })

type ItemOf<P> = P extends PageAnswer<infer Item> ? Item : never

export type Task = ProcedureResult<typeof api.tasks.get>
export type Comment = ItemOf<ProcedureResult<typeof api.comments.list>>
```

```tsx web/mine.tsx
import { Can, useInfiniteQuery, useMutation } from '@fabrika/app/react'
import {
	Button,
	type Column,
	DataTable,
	PageHeader,
	StatusPill,
	Tabs,
	useSelection,
	useToast,
} from '@fabrika/ui'
import { useState } from 'react'
import { api, type Task } from './api'
import { Link } from './routes'

type Tab = 'open' | 'doing'

const columns: readonly Column<Task>[] = [
	{
		key: 'title',
		header: 'Task',
		grow: true,
		cell: (task) => <Link to="task" params={{ id: task.id }}>{task.title}</Link>,
	},
	{ key: 'due', header: 'Due', cell: (task) => task.dueOn ?? '' },
	{
		key: 'status',
		header: 'Status',
		cell: (task) => (
			<StatusPill
				tone={task.overdue
					? 'danger'
					: task.status === 'doing'
					? 'info'
					: 'neutral'}
			>
				{task.status}
			</StatusPill>
		),
	},
]

export function MyTasks() {
	const mine = useInfiniteQuery(api.tasks.mine, {})
	const start = useMutation(api.tasks.start)
	const toast = useToast()
	const selection = useSelection()
	const [tab, setTab] = useState<Tab>('open')
	const shown = mine.items.filter((task) => task.status === tab)
	const startAll = async (ids: readonly string[]) => {
		for (const task of shown.filter((candidate) => ids.includes(candidate.id))) {
			const outcome = await start.mutate({
				id: task.id,
				expectVersion: task.version,
			})
			if (!outcome.ok) {
				toast.show({ tone: 'danger', message: outcome.error.message })
			}
		}
		selection.clear()
	}
	return (
		<>
			<PageHeader
				title="My tasks"
				lead="Open tasks assigned to you, soonest first."
			/>
			<Tabs
				label="Task status"
				items={[
					{
						key: 'open',
						label: 'Open',
						count: mine.items.filter((task) => task.status === 'open').length,
					},
					{
						key: 'doing',
						label: 'In progress',
						count: mine.items.filter((task) => task.status === 'doing').length,
					},
				]}
				active={tab}
				onChange={setTab}
			/>
			<DataTable
				caption="My tasks"
				columns={columns}
				rows={shown}
				rowKey={(task) => task.id}
				status={mine.status === 'error'
					? 'error'
					: mine.status === 'success'
					? 'ready'
					: 'loading'}
				error={mine.error?.message}
				onRetry={() => void mine.retry()}
				empty="Nothing assigned to you."
				loadMore={{
					hasMore: mine.hasMore,
					loading: mine.loadingMore,
					onLoadMore: () => void mine.loadMore(),
				}}
				selection={tab === 'open' ? selection : undefined}
				selectRowLabel={(task) => `Select ${task.title}`}
				selectionActions={(ids) => (
					<Can action="tasks.write">
						<Button
							size="sm"
							variant="primary"
							loading={start.pending}
							onClick={() => void startAll(ids)}
						>
							Start
						</Button>
					</Can>
				)}
			/>
		</>
	)
}
```

- `useQuery(api.tasks.get, { id })` answers `{ status, data, error, fetching, refetch }`: `status` is `'loading'`,
  `'success'` (then `data` is the parsed answer, typed by the contract), `'error'` (then `error` is a `FabrikaError`)
  or `'idle'`. Read `data` only after checking `status`; the compiler insists. A procedure without input takes none:
  `useQuery(api.members.orgs)`.
- Pass `skip` as the input while a value it needs is not known yet: `useQuery(api.members.list, project ? { orgId } :
  skip)` sends nothing until then.
- Every view of one call with one input shares one request and one cached answer.
- `useInfiniteQuery(procedure, input)` is for a list that answers `{ items, next }` and takes `after`: `items` are the
  loaded pages, `hasMore` and `loadMore()` the next page. `{ pages: 'all' }` reads every page at once, for a picker's
  options; use it for small lists only.
- An offset list that answers `{ items, total }` and takes `limit` and `offset` is `useQuery` with `{ keepPrevious:
  true }`: while the answer of a new `limit` or `offset` loads, `data` stays the previous answer (`status: 'success'`,
  `fetching: true`), so the table keeps its rows. "Load more (n of N)" grows `limit` in the page's state:
  `useQuery(api.tasks.queue, { orgId, limit, offset: 0 }, { keepPrevious: true })` with `loadMore={{ hasMore:
  data.items.length < data.total, loading: queue.fetching, onLoadMore: () => setLimit(limit + 50) }}`; a pager sets
  `offset` instead. A filter change resets `limit` or `offset`.

## Writing: useMutation, forms and their errors

```tsx web/edit-task.tsx
import { type FabrikaError, useMutation } from '@fabrika/app/react'
import {
	Button,
	DateInput,
	Dialog,
	Field,
	Form,
	FormActions,
	type FormErrorLike,
	Input,
} from '@fabrika/ui'
import type { Task } from './api'
import { api } from './api'

/** What the person reads: the field errors as they are, a stale version and a missing role in plain words. */
export function shown(error: FabrikaError | null): FormErrorLike | null {
	if (error === null) return null
	if (error.kind === 'conflict') {
		return {
			message: 'Someone changed this task meanwhile. Close and open it again.',
		}
	}
	if (error.kind === 'forbidden') {
		return { message: 'Your role does not allow this.' }
	}
	return error
}

const text = (form: FormData, name: string): string => {
	const value = form.get(name)
	return typeof value === 'string' ? value.trim() : ''
}

export function EditTask(
	{ task, open, onClose }: {
		readonly task: Task
		readonly open: boolean
		readonly onClose: () => void
	},
) {
	const edit = useMutation(api.tasks.edit)
	const close = () => {
		edit.reset()
		onClose()
	}
	const submit = async (form: FormData) => {
		const due = text(form, 'dueOn')
		const outcome = await edit.mutate({
			id: task.id,
			expectVersion: task.version,
			title: text(form, 'title'),
			dueOn: due === '' ? null : due,
		})
		if (outcome.ok) close()
	}
	return (
		<Dialog open={open} title="Edit task" onClose={close}>
			<Form
				onSubmit={(form) => void submit(form)}
				error={shown(edit.error)}
				aria-label="Edit task"
			>
				<Field label="Title" name="title" required>
					<Input defaultValue={task.title} />
				</Field>
				<Field label="Due on" name="dueOn" hint="Leave empty for no due date.">
					<DateInput defaultValue={task.dueOn ?? ''} />
				</Field>
				<FormActions>
					<Button variant="ghost" onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" loading={edit.pending}>
						Save
					</Button>
				</FormActions>
			</Form>
		</Dialog>
	)
}
```

- `mutate(input)` never throws: it answers `{ ok: true, data }` or `{ ok: false, error }`, and the hook keeps
  `status`, `pending`, `data` and `error`. It first checks the input with the procedure's own schema: a refused input
  is a `validation` error with its field paths, and nothing is sent.
- After a success, and after a `conflict`, it refetches what its group shows (`api.tasks` for `api.tasks.edit`). Key
  a form that edits a versioned row by its version (`key={task.version}`): after a conflict it reseeds from the
  current row, and the next save sends the current `expectVersion`.
  `useMutation(api.comments.add, { invalidates: [api.comments, api.tasks.get] })` names other procedures or groups;
  `invalidates: []` refetches nothing. `useInvalidate()(api.tasks)` refetches on demand.
- `FabrikaError` is one union for every refusal: `unauthenticated` (`loginUrl`: the client made with `bounceOnAuth`
  sends the person there itself), `forbidden` (the role lacks the action: tell the person, never loosen the contract),
  `conflict` (a stale `expectVersion`, or a `ConflictError` of the handler), `validation` (`fields`: input path →
  message, also a handler's `BadRequestError` without fields), `not-found`, `other` (`status`; `0` when no answer came).
- `Form` shows its `error`: a summary on top, and each `fields[name]` under the `Field` of that `name`. `Field` gives
  its control the `name`, an `id`, its label and `aria-describedby`; the control needs nothing else. `Form` hands
  `onSubmit` the `FormData`: read the fields by name, and leave the checking to the procedure's schema.
- A call that is no procedure — a file collection's `api.files.<name>.upload(owner, file)`, `list`, `download` —
  runs through `useAction(async (input) => …)`, with the same state and error union; it refetches only what
  `invalidates` names.
- An attachment procedure (`output: attachment(…)`) downloads through `useDownload(api.reports.exportProject)`:
  `mutate(input)` saves the file and answers it, with the same state and error union. It runs on the provider's client,
  so a screen test downloads over the kit; never call `download(api.…)` of the module's client from a screen.

## Who is signed in: useCaller and Can

```tsx web/project.tsx
import { Can, useCaller, useInfiniteQuery } from '@fabrika/app/react'
import {
	ButtonLink,
	Card,
	EmptyState,
	Field,
	FilterBar,
	Input,
	PageHeader,
	Select,
} from '@fabrika/ui'
import { useState } from 'react'
import { api } from './api'
import { href, Link } from './routes'

const STATUSES = [{ value: 'open', label: 'Open' }, {
	value: 'doing',
	label: 'In progress',
}, { value: 'done', label: 'Done' }]
const isStatus = (value: string): value is 'open' | 'doing' | 'done' =>
	STATUSES.some((status) => status.value === value)

export function ProjectTasks(
	{ orgId, projectId }: { readonly orgId: string; readonly projectId: string },
) {
	const caller = useCaller()
	const [status, setStatus] = useState('')
	const [title, setTitle] = useState('')
	const tasks = useInfiniteQuery(api.tasks.list, {
		projectId,
		...(isStatus(status) ? { status } : {}),
		...(title.trim() === '' ? {} : { title: title.trim() }),
	})
	return (
		<>
			<PageHeader
				title="Project tasks"
				back={{ href: href('mine'), label: 'My tasks' }}
				lead={caller === null ? undefined : `Signed in as ${caller.email}`}
				actions={
					<Can action="tasks.write" scope={{ type: 'org', value: orgId }}>
						<ButtonLink variant="primary" href={href('mine')}>New task</ButtonLink>
					</Can>
				}
			/>
			<FilterBar
				onReset={() => {
					setStatus('')
					setTitle('')
				}}
			>
				<Field label="Status">
					<Select
						value={status}
						onChange={(event) => setStatus(event.currentTarget.value)}
						placeholder="Any status"
						options={STATUSES}
					/>
				</Field>
				<Field label="Title">
					<Input
						type="search"
						value={title}
						onChange={(event) => setTitle(event.currentTarget.value)}
					/>
				</Field>
			</FilterBar>
			<Card title="Tasks">
				{tasks.items.length === 0
					? <EmptyState title="No tasks" text="No task of this project matches." />
					: (
						<ul>
							{tasks.items.map((task) => (
								<li key={task.id}>
									<Link to="task" params={{ id: task.id }}>{task.title}</Link>
								</li>
							))}
						</ul>
					)}
			</Card>
		</>
	)
}
```

- `useCaller()` answers `{ label, email, can(action, scope?) }` from the SPA mount's caller document, or `null` while
  it loads and on a public SPA. `can(action)` is the action held app-wide or in any scope value; `can(action, { type,
  value })` app-wide or in that value. A grant on a container is not seen from a value inside it: ask at the dimension
  the person holds the role in.
- `<Can action scope fallback>` shows its children only then. **It is information for the page, never a check**: the
  proxy and the endpoint decide every call again, so a hidden button protects nothing, and a shown one may still be
  refused (`forbidden`).
- A filter goes into the query's input (the server filters, the cache keys by it) when the procedure takes it, as
  `status` and `title` above; filter loaded rows in the page only for what the procedure does not take.

## A detail screen

```tsx web/task.tsx
import { useInfiniteQuery, useMutation, useQuery } from '@fabrika/app/react'
import {
	Button,
	Card,
	Columns,
	ConfirmDialog,
	ErrorState,
	FieldList,
	Form,
	FormActions,
	LoadingState,
	PageHeader,
	Section,
	SidePanel,
	StatusPill,
	Textarea,
	Timeline,
	useToast,
} from '@fabrika/ui'
import { useState } from 'react'
import { api, type Task } from './api'
import { EditTask, shown } from './edit-task'
import { href } from './routes'

function Comments({ task }: { readonly task: Task }) {
	const comments = useInfiniteQuery(api.comments.list, { taskId: task.id }, {
		pages: 'all',
	})
	const add = useMutation(api.comments.add)
	const [formKey, setFormKey] = useState(0)
	return (
		<Section title="Comments">
			<Timeline
				items={comments.items.map((comment) => ({
					id: comment.id,
					at: comment.createdAt.slice(0, 16),
					title: comment.createdBy,
					body: comment.body,
				}))}
				empty="No comments yet."
			/>
			<Form
				key={formKey}
				error={shown(add.error)}
				onSubmit={async (form) => {
					const body = form.get('body')
					if (
						(await add.mutate({
							taskId: task.id,
							body: typeof body === 'string' ? body : '',
						})).ok
					) setFormKey(formKey + 1)
				}}
			>
				<Textarea name="body" rows={2} aria-label="Comment" />
				<FormActions>
					<Button type="submit" loading={add.pending}>Comment</Button>
				</FormActions>
			</Form>
		</Section>
	)
}

function TaskScreen({ task }: { readonly task: Task }) {
	const close = useMutation(api.tasks.close)
	const toast = useToast()
	const [editing, setEditing] = useState(false)
	const [closing, setClosing] = useState(false)
	return (
		<>
			<PageHeader
				title={task.title}
				back={{ href: href('mine'), label: 'My tasks' }}
				meta={
					<StatusPill tone={task.overdue ? 'danger' : 'neutral'}>
						{task.status}
					</StatusPill>
				}
				actions={
					<>
						<Button onClick={() => setEditing(true)}>Edit</Button>
						<Button variant="danger" onClick={() => setClosing(true)}>
							Close task
						</Button>
					</>
				}
			/>
			<Columns>
				<Comments task={task} />
				<SidePanel>
					<Card title="Details">
						<FieldList
							items={[{ label: 'Assignee', value: task.assigneeLabel }, {
								label: 'Due on',
								value: task.dueOn,
							}]}
						/>
					</Card>
				</SidePanel>
			</Columns>
			<EditTask task={task} open={editing} onClose={() => setEditing(false)} />
			<ConfirmDialog
				open={closing}
				title="Close this task?"
				message="A closed task leaves the lists of open work."
				confirmLabel="Close task"
				tone="danger"
				pending={close.pending}
				onCancel={() => setClosing(false)}
				onConfirm={async () => {
					const outcome = await close.mutate({
						id: task.id,
						expectVersion: task.version,
					})
					setClosing(false)
					toast.show(
						outcome.ok
							? { tone: 'success', message: 'Task closed' }
							: { tone: 'danger', message: outcome.error.message },
					)
				}}
			/>
		</>
	)
}

export function TaskView({ id }: { readonly id: string }) {
	const task = useQuery(api.tasks.get, { id })
	if (task.status === 'success') return <TaskScreen task={task.data} />
	if (task.status === 'error') {
		return (
			<ErrorState
				text={task.error.message}
				onRetry={() => void task.refetch()}
			/>
		)
	}
	return <LoadingState />
}
```

## The components

All are named exports of `@fabrika/ui`, keyboard operable, and labelled for assistive technology. Text they render
themselves ("Load more", "Clear selection", "Close", "Retry") is a prop with an English default.

| Component                                                                                    | What it is                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppShell({ brand, nav, user, actions, topBar, navStyle })`                                  | sidebar navigation (`{ label, href, active, count }`), a top bar with the caller (none without `user` or `actions`, or with `topBar={false}`), the main region; `navStyle="filled"` fills the current item |
| `PageHeader({ title, lead, back, actions, meta })`                                           | the screen's `h1`, a line of purpose, a back link, its buttons; one `primary` button per screen                                                                                                            |
| `Tabs({ label, items, active, onChange, variant })`                                          | tabs with counts; arrow keys, Home and End; `variant="boxed"` frames each tab, its count after a dot                                                                                                       |
| `FilterBar({ onReset })` + `Field`                                                           | a row of filters with a reset                                                                                                                                                                              |
| `Field({ label, name, hint, error, required })`                                              | label, hint and error around one control; the error comes from the `Form` by `name`                                                                                                                        |
| `Input`, `Textarea`, `Select({ options, placeholder })`                                      | the controls; native props pass through                                                                                                                                                                    |
| `DateInput`, `DateRange({ from, to, onChange })`                                             | a day, and a from–to pair of days                                                                                                                                                                          |
| `Checkbox({ label, checked, onChange, indeterminate })`                                      | one checkbox                                                                                                                                                                                               |
| `RadioGroup({ label, name, options, value, onChange })`                                      | a fieldset of radios                                                                                                                                                                                       |
| `Button({ variant, size, loading })`, `ButtonLink`                                           | `primary`, `secondary` (default), `ghost`, `danger`; `loading` disables and shows a spinner                                                                                                                |
| `DataTable({ columns, rows, rowKey, status, selection, selectionActions, loadMore, empty })` | compact rows, loading/error/empty rows, a selection toolbar, a load-more button; a column takes `width` (`'xs'`…`'xl'`) and `wrap`                                                                         |
| `useSelection()`                                                                             | the `selection` a `DataTable` takes, with `clear()`                                                                                                                                                        |
| `StatusPill({ tone, dot })`                                                                  | `neutral`, `info`, `success`, `warning`, `danger`, `accent`; `dot={false}` leaves the dot out                                                                                                              |
| `FieldList({ items, columns })`                                                              | label/value pairs; an empty value shows a dash                                                                                                                                                             |
| `Card({ title, actions, footer })`, `Section({ title, description, actions })`               | a framed block, and a titled block without the frame                                                                                                                                                       |
| `Columns` + `SidePanel`                                                                      | the main column and a side column, stacked on a narrow screen                                                                                                                                              |
| `Dialog({ open, title, onClose })`, `ConfirmDialog`                                          | modal: focus moves in and is trapped, Escape closes, focus returns                                                                                                                                         |
| `ToastProvider`, `useToast().show({ tone, message })`                                        | short notices that leave by themselves                                                                                                                                                                     |
| `Timeline({ items, empty })`                                                                 | history and notes: `{ id, at, title, body }`                                                                                                                                                               |
| `EmptyState`, `ErrorState({ text, onRetry })`, `LoadingState`, `Spinner`, `CountBadge`       | the states of a region                                                                                                                                                                                     |
| `Stack({ gap })`, `Inline({ gap, align, justify, wrap })`                                    | layout with the spacing scale                                                                                                                                                                              |
| `Form({ onSubmit, error })`, `FormActions`                                                   | a form that shows a hook's error: the summary and each field's message                                                                                                                                     |
| `createRouter(routes, { base })`                                                             | `Router`, `Link`, `useRoute`, `href`, `navigate`, typed by the patterns                                                                                                                                    |

## Theming

`@fabrika/ui/styles.css` holds the tokens (`theme.css`) and the components' rules, which read the tokens only. The
application imports it first, then its own stylesheet, which overrides tokens and styles only what the kit lacks:

```css
/* web/app.css */
:root {
	--fui-accent: #0f766e;
	--fui-accent-hover: #115e59;
	--fui-accent-soft: #e6f4f2;
}

body {
	margin: 0;
	background: var(--fui-bg);
}
```

- The palette is neutral with one accent (`--fui-accent*`), plus tones for status (`--fui-success`, `--fui-warning`,
  `--fui-danger`, `--fui-info`, each with `-soft` and `-text`). Typography (`--fui-font-family`, `--fui-text-*`),
  spacing (`--fui-space-1`…`8`), radii, borders and shadows are tokens too.
- So are the parts a design changes most: the main region's padding (`--fui-main-padding`, `-narrow` below the
  breakpoint), a field's label (`--fui-label-size`, `--fui-label-weight`, `--fui-label-color`), a table's column heads
  (`--fui-table-head-size`, `-weight`, `-color`, `-transform`, `-tracking`: `uppercase` and `0.04em` for small
  capitals) and the column widths (`--fui-column-width-xs`…`xl`). Change the look through tokens and the components'
  props (`navStyle`, `variant`, `dot`, a column's `width` and `wrap`); never restyle a kit class name (`.fui-…`), which
  is no contract and changes with the kit.
- Light is the default. `<html data-theme="dark">` switches to the dark token set; the page decides when (a toggle, or
  `matchMedia('(prefers-color-scheme: dark)')`).
- The kit loads nothing from another origin, so it runs under the default CSP. The font token is a system stack; for
  a typeface, put its files in the SPA's bundle (import its `@font-face` stylesheet from `web/start.tsx`) and
  override `--fui-font-family`, or name the font service's origins in the contract's `csp` (`styleSrc`, `fontSrc`,
  `app-setup.md`).

## Testing a screen

A screen test renders the page in happy-dom (`@happy-dom/global-registrator`, a devDependency) over the application
itself, behind the test kit's proxy decision: the provider gets a client whose `fetch` is the kit's browser for a
test caller. `installDom` of `@fabrika/app/react/testing` sets the DOM up.

```ts web/__tests__/dom.ts
import { installDom } from '@fabrika/app/react/testing'
import { afterAll } from 'bun:test'

const dom = installDom({ url: 'http://tasks.test/' })
afterAll(() => dom.uninstall())
```

```tsx web/__tests__/mine.test.tsx
import './dom'
import { createClient } from '@fabrika/app/client'
import { FabrikaProvider } from '@fabrika/app/react'
import { waitForText } from '@fabrika/app/react/testing'
import { testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { ToastProvider } from '@fabrika/ui'
import { afterAll, expect, test } from 'bun:test'
import { createRoot } from 'react-dom/client'
import { contract } from '../../fabrika.contract'
import app from '../../src/app'
import { MyTasks } from '../mine'

const postgres = await testDatabase({
	migrations: new URL('../../db/migrations/', import.meta.url),
	label: 'web/mine.test.tsx',
})

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database })
	const member = kit.testCaller([{
		role: 'member',
		scope: kit.scope('org', 'acme'),
	}])

	test('a member with nothing assigned sees the empty list, and no start button', async () => {
		const fetch = kit.browser(member)
		const root = createRoot(
			document.body.appendChild(document.createElement('div')),
		)
		root.render(
			<FabrikaProvider
				clients={[createClient(contract, 'api', { fetch })]}
				fetch={fetch}
			>
				<ToastProvider>
					<MyTasks />
				</ToastProvider>
			</FabrikaProvider>,
		)
		await waitForText('Nothing assigned to you.')
		expect(document.body.textContent).toContain('Nothing assigned to you.')
		expect(document.querySelector('[role="toolbar"]')).toBeNull()
		root.unmount()
	})
}
```

- `web/__tests__/dom.ts` comes first: imports run in order, and React reads `window` when it loads. `installDom` keeps
  Bun's `fetch`, `AbortController`, `URL`, `Blob`, `File` and `FormData`, because the clients, the kit, a form's
  challenge and a download run on them, and turns navigation off, so a download's link click leaves the page for the
  next test. Run the tests with `bun test --isolate`, which gives each file its own globals.
- `await type('Title', 'report')` types into the control whose label (or `aria-label`) is `Title` as React reads a
  person typing; a select takes the option's value. `controlByLabel(label)` answers the control, and
  `waitForText(text)` waits until the page shows it.
- Wait for what the page shows, as a person does; assert on text, roles and ARIA, never on layout (happy-dom lays out
  nothing). A refused twin is a caller without the role: the button is gone, and the endpoint still answers 403.
- Pure mapping (a label, a tone, a field's value) is a function of `web/` with a plain test.

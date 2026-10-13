> **OUTCOME — shipped 2026-10-13.** An application invites people from outside the organization by e-mail and IAM
> keeps them out of internal roles. IAM knows a principal's affiliation and a role declared `external`; an external
> holds only such roles, at every grant write, at reconcile and at resolution, issues only self-bound keys, never
> authenticates by OIDC and is promoted only by an installation admin (WU1, ADR-0051). An application-wide staff role
> may assign a membership role (WU2). IAM's pages and e-mails speak the application's language (`en`, `cs`), refusals
> included, and a password action or an invitation ends in the application (WU3). An application words IAM's e-mails
> in plain text; IAM builds the HTML (WU4, an MVP). One e-mail onboards a new external person: the principal is created
> at acceptance with its password and grant in one transaction, under the inviter's checked authority and schema
> revision, never over another signed-in account; resend rotates the link (WU5). Before them, backlog 113 gave the
> generated tests a stand-in IAM for writes, and WU25 closed the fresh-agent trial's last gaps (`statusOf`, the loop's
> wording, backlog 137). The owner cut the partner-portal recipe (WU6), application-authored HTML and repeated review
> rounds. Every unit had a GPT review; WU1 took four rounds (independent keys, two Postgres races, two deadlocks), WU5
> two (two P1 races). Commit map: backlog 113 → `aedd6992`…`aefc55f4`, WU3 → `fd0d21cc`…`c96aca62`, WU25 →
> `de0876ee`…`c4bf574b`, WU1 → `c99bcc69`…`5778ddd5`, WU4 → `859e8691`…`0b75f748`, WU2 → `6c0338ef`…`52cbd14f`, WU5 →
> `a381cbf9`…`3dbcdab7`. Verification at `3dbcdab7`: typecheck, lint, `format:check`, and `bun run test` with Postgres
> and S3: 7465 pass, 38 skip, 0 fail; the agent interfaces 318, `examples/zerops-app` 47 and `examples/crm` 162 pass,
> 0 fail. The fresh-agent trial of group B after WU24/WU25: opus-b 3 runs (1 failing), within the cap; gpt-b 4 runs (1
> failing) in each of rounds 3, 4 and 5, one over the cap, each failure in the agent's own test code. Backlog closed:
> 113, 137. Deferred: a browser run of the flows (138), application HTML e-mails (139), the stand-in's missing
> membership answers (140), the supplementing-grant race (141).

# Sprint — external people and a complete password flow (2026-10-13)

**Goal.** An application invites people from outside the organization by e-mail, in its own language and wording;
they set a password and sign in, and IAM guarantees they never hold an internal role.

**Theme.** The driving case is an internal application of one of our projects: its staff sign in through the
organization's OIDC, and the partner companies it works with get accounts of their own. A staff member invites one or
more people of a company; each receives the application's e-mail with a link that sets the password and opens the
application; they then see only their company. Today an application cannot onboard a person IAM does not know, every
e-mail and page is fixed English, and nothing tells an internal person from an external one. The batch succeeds when
that application's backend is written on the paved road, with the invitation, the reset and the removal working end
to end in a browser.

Design consulted with GPT (gpt-6-astra) and Opus, both read-only over HEAD; they agreed on every point below except
when the external principal is created (decision D3).

## Refs re-verified at HEAD (2026-10-13)

- ✔ Principals are `user` | `service`; nothing marks a person external — `packages/iam/migrations-postgres/0001_init.sql:24`.
- ✔ An e-mail assignment opens a 7-day invitation and never creates a principal; acceptance needs a principal signed in
  on IAM with the invited mailbox — `packages/iam/src/membership.ts:66`, `packages/iam/src/auth/invitations.ts:31-41`.
- ✔ Only an installation admin creates a user (`inviteUser`) and issues its enrollment, as two operations —
  `packages/iam/src/admin/principals.ts:110-133`, `packages/iam/src/admin/passwords.ts:49`.
- ✔ A password action lives one hour — `packages/iam/src/password-service.ts:9`.
- ✔ Repeating an invitation sends nothing (`ON CONFLICT … DO NOTHING`) — `packages/iam/src/repositories/membership.ts:300-312`.
- ⚠ An assigner must hold its role in exactly the scope value: a global staff role cannot invite into a company —
  `packages/app/src/contract/build.ts:365-369`, `packages/iam/src/repositories/membership.ts:132-142`.
- ⚠ OIDC claims any principal with that mailbox and no `external_id`, a password-only one included, and a known
  principal skips the domain allowlist — `packages/iam/src/resolve.ts:157-170`, `packages/iam/src/auth/oidc.ts:92-102`.
- ⚠ The bootstrap admin is recognised by mailbox alone at resolution — `packages/iam/src/resolve.ts:263-267`.
- ✔ E-mails and pages are fixed English — `packages/iam/src/invitation-email.ts:13`, `packages/iam/src/password-email.ts:10`,
  `packages/iam/src/password-pages.ts:139`; a completed password action lands on IAM's own origin —
  `packages/iam/src/auth/password.ts:309-316`.
- ✔ Already there: the hybrid login renders password and SSO together (`packages/iam/src/auth/login.ts:50-57`),
  forgot-password enrolls a pending account (`auth/password.ts:241-243`), cancelling an invitation
  (`membership.ts:468-484`), password replacement revokes password-origin sessions (`password-db.ts:299`).

## Decisions

- **D1 — Affiliation is an IAM fact about the person, eligibility a contract fact about the role.**
  `principals.affiliation` (`internal` | `external`, default `internal` for every existing row) and `external: true` on
  a membership role. An external holds only grants of roles declared `external`; an internal may hold one too. Not
  derived from the authentication method or the mailbox domain. Not `audience` or `member`, which already mean other
  things.
- **D2 — No new token claim and no endpoint marker.** Endpoints require actions; the external role's actions in the
  company's scope are the boundary. The member directory and the console show the affiliation.
- **D3 — The external principal is created when the invitation is accepted** (GPT), not when it is sent (Opus). An
  unaccepted invitation leaves no account and reserves no mailbox.
- **D4 — Templates belong to the application** (owner's choice: full templates). The contract declares the subject, the
  text and the HTML of each IAM message (invitation, enrollment, reset) per language. IAM renders them with a closed set
  of variables, escapes every value, and puts in the action link itself. A template must contain `{{actionUrl}}`; any
  other link may point only to the application's registered return origins; no script, form, frame or remote resource.
  The checker refuses a bad template; IAM refuses it again at reconcile. A template change is a review line in the
  approval. IAM's own pages (sign-in, set password, forgot password, invitation outcome) stay IAM's, localized from its
  catalog with the application's display name, because a page that takes a password is never app-authored.
- **D5 — Reset is self-service, plus the installation admin in IAM's console** (owner's choice). No staff button in
  the application. A reset started from the application's sign-in uses its template and returns to it.
- **D6 — Removing a person removes their access to the company** (owner's choice). Their roles there go; the account
  stays, because other companies or applications may use it; access ends within the token TTL (300 s). No automatic
  disabling.
- **D7 — A company is application data, not IAM structure.** Backlog 91 (org units and groups) is independent; when it
  lands, a group must not give an external an internal role either.
- **D8 — Promotion is an installation-admin operation.** An external becomes internal only there, audited; OIDC never
  claims an external principal and never creates one.

## Work units

### WU1 — External principals and external roles (L)

- **Problem.** No affiliation exists, and three paths would give an external internal authority: OIDC claiming the row,
  the bootstrap mailbox, and admin grants (inline, custom policy, cross-app).
- **Verify first.** List every grant-writing path in `packages/iam/src/repositories/grants.ts` and `membership.ts`, and
  every resolution input in `resolve.ts`.
- **Scope.** Migration (D1 and Postgres) for `principals.affiliation` and `roles.external`; `RoleDef.external` in the
  contract (membership roles only), the artifact schema and the reconcile; the rule enforced at grant write (admin,
  membership, acceptance, scope creation), at reconcile (409 when a role loses `external` while an external holds it,
  plus the batch guard) and at resolution (an incompatible grant contributes nothing; no bootstrap or cross-app
  authority for an external); OIDC refuses an external row with a fixed `LoginRefusal`, and the domain allowlist also
  applies to a known principal with no `external_id`; admin creation of an external and promotion; the console badge;
  `affiliation` in `listMembers`/`findMember` items; a checker hint for a `{ member: true }` endpoint in a contract
  that declares an external role. A new ADR "External principals"; ADR-0020 and ADR-0022 rule 6 amended.
- **Acceptance / witness.** IAM tests on both backends: each write path refuses an internal role for an external; a
  grant written before a schema narrowing contributes nothing; an OIDC login with an external's mailbox is refused;
  a bootstrap mailbox held by an external is no admin; promotion then lets OIDC claim.

### WU2 — An application-wide role may assign a membership role (M)

- **Problem.** `assignableBy` names only membership roles of the same dimension (`build.ts:365`), so staff cannot invite
  into a company they did not create.
- **Scope.** `assignableBy` may also name a role of the application with no `member`; IAM's `roleAuthorityProblem`
  accepts that role's global grant. `members.manage`, the action ceiling and the delegation grant stay; the acceptance
  re-check uses the same rule. ADR-0022 rule 6 wording.
- **Acceptance / witness.** A staff member with only the global role invites into a company; after losing that role the
  open invitation's acceptance is `not_allowed`.

### WU3 — IAM speaks the application's language (M)

- **Scope.** A catalog (`en`, `cs`) for every IAM page and its own default e-mails; the contract's `locale` and
  `displayName`, reconciled; the language chosen from the request's application, then `principals.locale`, then the
  installation default; a password action and an invitation keep their application and return to it after completion.
- **Acceptance / witness.** Page tests per locale; a browser run: sign-in from the application, forgot password, reset,
  back in the application.

### WU4 — Application e-mail templates, an MVP (S)

- **Scope.** The owner cut D4 to an MVP: per message kind and locale, the contract declares an inline `subject` and a
  plain-text `text` with `{{name}}` placeholders from the closed set (display name, recipient, inviter label, company
  label, personal message, action URL, expiry). The checker and IAM's reconcile refuse an unknown placeholder and a
  `text` without `{{actionUrl}}`. IAM renders the text and builds the HTML part itself (the escaped text plus its own
  button). Application-authored HTML is deferred.
- **Acceptance / witness.** The two refusals, escaping in the HTML part, a `cs` application's reset on its template,
  the catalog fallback.

### WU5 — One e-mail onboards a new external person (L)

- **Scope.** D3: `ctx.members.assign` by e-mail with a role declared `external` takes `{ label, message }`; the invitation
  stores them and the application's locale. The accept page for a mailbox IAM does not know renders set-password; its
  POST creates the external principal, stores the password, activates it, writes the grant and consumes the invitation
  in one transaction, then signs the person in and sends the browser to the application through the normal handoff.
  An existing mailbox keeps today's sign-in-and-accept. A bootstrap mailbox or one the OIDC allowlist names explicitly
  is refused. An explicit resend rotates the token and restarts the 7 days. ADR-0020 amended (an invitation-bound
  enrollment, its 7-day exception) and ADR-0022 rule 6 (a membership write may create an external principal).
- **Acceptance / witness.** Tests: a scanner GET changes nothing; two concurrent acceptances create one principal; a
  resent link invalidates the old one; the inviter's removal before acceptance refuses it. A browser run of the whole
  path, also for a person invited by two companies.

## Out of scope (explicit)

- Org units and groups (backlog 91); delegated administration of global roles (backlog 126).
- A staff-triggered reset in the application (D5); automatic disabling after the last membership (D6).
- Immediate revocation below the 300 s token TTL: it needs an ADR-0022 decision of its own.
- Branding of IAM's pages beyond the display name; SCIM; several IdPs or account linking.
- An IAM suspension of a company's scope value: the active flag is application data.
- Cut by the owner to ship sooner: the skill's partner-portal recipe (was WU6; the skill gets a short note on
  external roles and invitations with WU5), application-authored HTML templates (WU4 is an MVP), and repeated review
  rounds (one GPT review per unit; a re-review only after a P0/P1).

## Sequencing

WU1 first: every later unit depends on affiliation. WU2 and WU3 then run in parallel. WU4 needs WU3's locale; WU5 needs
WU1, WU2 and WU4.

## Run log

- **Backlog 113, done.** The endpoint access kit boots with a stand-in IAM for writes
  (`kitMembership`, `packages/app/src/testing/membership.ts`): delegation, `creates` (global grant), `members.manage`
  on the value, `assignableBy`, the role's actions, `issuedBy` and the link grants on the chain. A `creates` endpoint
  gets two cases (one-scope holder 403, global holder answered). Its `assignableBy` check is today's (a membership
  role in the exact value); WU2 widens IAM's rule, and the stand-in must follow it. Gap left for WU6: an `on` endpoint
  that cancels an invitation or revokes a link by id fails its generated cases (the stand-in answers an unknown id
  404, as IAM does); the skill's "Not built yet" says so.
- WU3: `locale` and `displayName` sit beside `app` in the vocabulary (the artifact carries each only when declared, so
  digests stay; a change is a widening approval line, because the name stands beside a password field). IAM stores
  them in `app_presentation` and the forgot-password app in `password_action_tokens.app` (migration 0011, both
  dialects). No `principals.locale`: an app-less action speaks the installation default, `en`, which is a constant, not
  a deploy variable. A completed action or an accepted invitation lands on the app's first registered return origin;
  the set-password and invitation pages widen `form-action` by that one origin, as the login page does for a handoff.
  WU4 replaces `messageTemplatesFor` (`packages/iam/src/messages.ts`) with the application's templates over the same
  `MessageValues`. A browser run of sign-in → forgot → reset → back in the application is still owed.
- **WU1 (2026-10-13).** Shipped → [ADR-0051](../decisions/0051-external-principals.md). Deviations: the domain
  allowlist's known-principal bypass now admits only an internal principal (an internal invited row keeps today's
  bypass, so hybrid linking is unchanged), rather than applying the allowlist to every row with no `external_id`.
  Review round: promotion revokes the principal's sessions and pending password actions, because it widens what
  the principal reaches (a bootstrap mailbox becomes an installation admin). The checker's hint is
  `member-admits-external`. `resolveUserPrincipal`'s label-refresh warning no longer names the IdP mailbox.
- WU4 (MVP, owner's scope cut): `mail` beside `locale` in the vocabulary holds a subject and a plain text per message
  and language, inline strings (8 KiB text, 200-character one-line subject), with `{{name}}` placeholders from
  `MAIL_PLACEHOLDERS` (`@fabrika/auth-core`); `companyLabel` and `message` are empty until WU5 passes them. The build,
  the checker and IAM's reconcile refuse an unknown placeholder and a text without `{{actionUrl}}` with one rule
  (`mailTemplateProblems`). IAM stores them in `app_mail_templates` (migration 0013, both dialects, after WU1's 0012), renders the text as is and writes the HTML part itself (escaped paragraphs and its own button). A change is one
  widening approval line: the diff has no generic contract-change line, so without it a template change read
  `unchanged`. **Deferred:** application-authored HTML templates (the sanitizer, link rules against registered return
  origins, and files beside the contract).
- **WU2 (2026-10-13).** Shipped: `assignableBy` may name an application-wide role (no `member`, never a built-in);
  the build and IAM's schema parser accept it, and IAM counts that role held in the value or as a global grant
  (`ASSIGNING_GRANT`, `repositories/membership.ts`), at assignment, revocation, the acceptance re-check and inside the
  acceptance's guarded `EXISTS` (`FOR SHARE` on Postgres). The stand-in follows; the generated cases' manager may now
  hold an application-wide assigner, always in the value. ADR-0022 rule 6 states who assigns.
- **WU5 (2026-10-13).** Shipped: `ctx.members.assign(ref, { email }, role, { label, message, resend })` (`InvitationOptions`,
  bounds in `invitationOptionsProblem`; migration 0014 stores `company_label` and `message` on the invitation). The
  smaller resend API was chosen: `resend: true` on assign rotates the open invitation's token and restarts its 7 days,
  no new IAM method. The accept POST answers a set-password form when `invitationOffer` is `create`; its POST runs
  `MembershipRepository.acceptAsNewPrincipal`, one batch from the principal row to the three records, then the IAM
  session and the landing. Every acceptance now names the token hash in its guarded write. An assign to an external
  role for an address `organizationMailbox` names (bootstrap, an exact `HUMAN_EMAILS` entry, a `HUMAN_EMAIL_DOMAINS`
  domain) is `internal_mailbox`, whether or not a principal holds it, so the answer says nothing about who has an
  account. **Still owed:** the browser run of the whole path, also for a person invited by two companies.

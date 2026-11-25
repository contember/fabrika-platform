# Human authentication

IAM composes OIDC and password authentication as independent capabilities. The
combination is derived from two switches; there is no separate hybrid mode.

| OIDC | Password | Login behavior                                                 |
| ---- | -------- | -------------------------------------------------------------- |
| on   | off      | `/auth/login` continues directly to OIDC.                      |
| off  | on       | `/auth/login` renders the password form.                       |
| on   | on       | The form offers both password and OIDC continuation.           |
| off  | off      | Configuration is invalid and startup or materialization fails. |

The runtime switches are `OIDC_ENABLED` and `PASSWORD_ENABLED`. An installation
sets them through `FABRIKA_IAM_OIDC_ENABLED` and
`FABRIKA_IAM_PASSWORD_ENABLED`. Missing switches retain the compatibility mode:
OIDC enabled and password disabled. New installations write both explicitly.

With OIDC enabled, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` are all
required and startup fails without any of them, on **both** runtimes. Refusing to
boot beats serving a method that can only fail at the redirect. A local
`wrangler dev` therefore runs password-only.

Where they are set depends on the installation. On Zerops they are variables of the
`iam` service: `FABRIKA_IAM_OIDC_ENABLED`, `FABRIKA_IAM_PASSWORD_ENABLED`, and the
unprefixed `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` (sensitive), which
is what IAM's Bun runtime reads (`packages/iam/src/node/runtime.ts`). `platform install`
writes them from `--auth-methods`, `--oidc-issuer`, `--oidc-client-id` and
`FABRIKA_IAM_OIDC_CLIENT_SECRET`, password only when none is given. Only the bring-up
writes them: `platform deploy` and `platform upgrade` neither write nor remove any, so a
change by hand survives both. IAM reads them at boot, so a change takes effect when `iam`
restarts. The human-admission allowlist below is unprefixed there too: `HUMAN_EMAIL_DOMAINS`
and `HUMAN_EMAILS`, each a JSON array of strings; the `FABRIKA_IAM_` spellings have no effect
on Zerops. The Zerops installer does not write them (it offers no `--human-email-domains`),
so they are set by hand. The redirect URI to register at the provider is `https://<iam host>/auth/callback`
(`ISSUER` + `/auth/callback`). The operator's procedure is the Zerops guide's "Turn on
single sign-on" (`fabrika platform guide --provider=zerops`).

The human-admission allowlist (`FABRIKA_IAM_HUMAN_EMAIL_DOMAINS` /
`FABRIKA_IAM_HUMAN_EMAILS`, a `*` in either meaning admit-all) governs
self-provisioning at the OIDC callback only, and is matched against the
IdP-verified email. It is not required configuration: empty and without a `*` it
admits only already-known or invited principals and bootstrap admins, which is
fail-closed. Password login never self-provisions, so it does not consult the list.

Enabling an email sender does not enable password login, and enabling password
login does not provision a credential for any user.

## How long an OIDC login lasts

An organization blocks a person at its identity provider, so IAM asks the provider
again on a fixed cap: an OIDC login, and every application session derived from it
(the console's included), is usable for `FABRIKA_IAM_OIDC_SESSION_HOURS` after its
sign-in, 12 hours when unset. Then the proxy's next token renewal is refused and IAM's
sign-in no longer honours the login, so the browser goes back to the provider (straight
there when OIDC is the only method). A provider that still holds its own session for
the person signs them in again without a prompt; one that blocked them refuses. A
token minted from the login ends at the cap too. The value is a whole number of hours
from 1 to 720 (the 30 days every IAM login lasts); anything else fails the boot.

The cap is measured at use from the sign-in, so lowering it, or upgrading to a release
that has it, also ends older logins on their next use. A new OIDC login stores the cap
as its expiry and cookie lifetime, so raising the cap later does not lengthen a login
already issued. Password logins are not capped: they keep 30 days. A key the person
issued or approved is not a login and is not capped by this; revoke it, or disable the
person in IAM, to end it.

Where it is set: on Zerops, a variable of the `iam` service under that name; on
Cloudflare, a deploy variable of IAM's Worker (`pipeline.vars` in
`packages/iam/fabrika.config.ts`), which the deploy passes as `OIDC_SESSION_HOURS`. No
installer writes it. IAM reads it at boot, so a change takes effect when `iam` restarts
or redeploys.

## Two-step sign-in for administrators

An administrator can add a second factor: a time-based code from an authenticator app (TOTP, RFC 6238: HMAC-SHA1,
30-second steps, 6 digits). An administrator is anyone IAM lets administer people: `iam.admin`, or `iam.users.manage`
in any scope. Enrolment is the person's own choice. IAM does not require it, so an administrator who has not enrolled
still signs in with one factor.

**Enrolment** is on IAM's `/auth/second-factor/enrol`, which the console's account menu links to as "Two-step sign-in".
It needs a current IAM login. A person who administers nothing gets a refusal page. The page shows a QR code (an SVG
`data:` image) and the same key as text. The authenticator is enrolled only when the person enters a first valid code.
IAM then shows ten recovery codes, once, and records `iam.second_factor.enrol`. While a person has an authenticator,
the page shows nothing to enrol. Setting up another one needs a reset first (below).

**At sign-in**, IAM asks a person with an enrolled authenticator for a code before it opens the session. The check sits
in `issueSession` (`auth/sessions.ts`), so it covers every way a person signs in:

- a password;
- an OIDC callback;
- a completed password setup or reset link;
- an invitation that creates the person.

An OIDC sign-in is asked too. IAM cannot see whether the identity provider asked for a second factor of its own, and
an administrator's account is the one worth the extra step. Two sign-ins are not asked: the local development bypass
(`local_dev`), and a person a terminal's application asserts
([Terminals](#terminals)). That assertion reaches only the asserting application, never IAM's administration.

The pending sign-in rides in a signed cookie, `__Host-fabrika_second_factor` (audience `fabrika:iam:second-factor`),
for 5 minutes. After that the person signs in again. The code form is `POST /auth/second-factor`. A code is accepted
within one step either side of now, and only once: IAM keeps the last accepted step, and refuses that step and every
earlier one.

**Wrong codes** are counted per account. The sixth attempt within 15 minutes is refused, and so is every attempt for
the next 15 minutes, a valid code included. A successful code clears the count. Each refusal writes `auth_log` with
reason `second_factor_invalid`, `second_factor_throttled` or `second_factor_expired`. The attempt that starts a block
also records `iam.second_factor.throttle`.

**Recovery.** Without the phone, the person can enter any unused recovery code in place of a code. Each code works once
and records `iam.second_factor.recovery_code.use`. For a lost phone with no recovery codes left, an installation
administrator resets the person's two-step sign-in. In the console this is "Reset two-step sign-in" on the person's
Sign-in tab; over `/admin/rpc` it is `secondFactor.reset`. The status is `secondFactor.get`. Both require `iam.admin`,
so a user administrator can do neither. The reset removes the authenticator and every recovery code, and records
`iam.second_factor.reset`. The person's next sign-in asks for no code until they enrol again. Confirm who is asking
before you reset.

**Storage.** IAM keeps the authenticator's secret sealed: AES-256-GCM under a fresh data key per value, with that data
key wrapped by the installation's `FABRIKA_IAM_DATA_KEY`. This is Control's vault construction, with the person's
principal id as associated data on both layers. A recovery code is stored only as a hash bound to its principal.

**The data key** is base64 of 32 random bytes. Where it comes from:

- **Zerops:** `platform install` writes it to the `iam` service as a sensitive variable. On an installation from
  before it, the next `platform deploy` or `upgrade` writes one once, because `iam` lacks the name. After that, no
  deploy writes it again.
- **Cloudflare:** `platform init` generates it into the account's GitHub Environment, and the workflow passes it to IAM's
  deploy. On an existing installation, re-run `fabrika platform init --provider=cloudflare <account>` with the same
  flags. That run writes the key and the workflow line that passes it, as for any sidecar workflow change. Until
  then, IAM's deploy declares no such secret.
- **Local stack:** `local:up` writes it into `.state/iam.env`.

Without the key, IAM boots and signs people in as before, and the enrolment page says two-step sign-in is unavailable.
A person who enrolled while the key was set is still asked for a code at sign-in. Their app code is then refused as
unavailable, but a recovery code still works, and so does an operator reset. Never replace the key: a new key opens
nothing sealed under the old one. There is no rotation: reset each person, and let them enrol again.

A stolen administrator session can enrol an authenticator of its own for an administrator who has none. The
enrolment is audited, and a reset removes it. Asking for a fresh sign-in before enrolment is not built. A passkey
step-up is ([Passkeys](#passkeys)), but it does not guard TOTP enrolment.

## Passkeys

Any person can keep passkeys (WebAuthn credentials) at IAM. A passkey confirms a sensitive step in the console: a
**step-up**. It does not sign anyone in. Sign-in stays as above.

**In the console**, the account menu has "Passkeys" (`/account/passkeys`). The page lists the person's passkeys, adds
one and removes one. The browser half of each ceremony runs on the console's page (`navigator.credentials`). IAM issues
every challenge and verifies every answer. The procedures are `passkeys.*` of IAM's `/admin/rpc`, which the console
reaches through Control's IAM gateway:

| Procedure                         | Who                                    | What                                                                           |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `list`                            | the person                             | their own passkeys: label, added, last used. No key material.                  |
| `registrationOptions`, `register` | the person                             | a registration challenge, then the attestation it answers                      |
| `remove`                          | the person                             | one of their passkeys, with an assertion bound to its removal                  |
| `challenge`, `verify`             | the person, or Control on their behalf | the step-up: a challenge bound to a string, and the verification of its answer |
| `listOf`, `reset`                 | `iam.admin`                            | another person's passkeys; the reset removes every one                         |

The person's procedures need a signed-in session's console token of a user. A token minted from a `px_` key is refused.

**The relying party** is the console the token was minted for. The origin is that application's first registered
return origin, and the RP ID is that origin's host. A passkey therefore answers on the console and on no other host. If
the console moves to another host, every passkey stops answering, and an administrator resets them.

**Each ceremony** asks for attestation `none`, user presence and user verification. IAM verifies the answer with
`@simplewebauthn/server`: the client data's type, challenge and origin, the RP ID hash, the flags, the attestation or
the signature, and the signature counter. A counter must move past the stored one; an authenticator that keeps none
reports 0 every time, which is accepted. The new counter is stored by compare-and-set, so two answers that race on one
counter accept one.

**A challenge** lives five minutes. It is issued to one person and answered once: the read that finds it also deletes
it, before anything is compared, so a wrong answer spends it too. A person holds at most ten open challenges, and the
cron removes expired ones. An assertion challenge carries a **binding**, an opaque string its issuer sets.
Verification takes the binding it expects and refuses any other. A challenge for one purpose never verifies for
another.

**Changing the set of passkeys takes a passkey already held.** The first passkey is registered with the session alone.
Another one is registered only with an assertion bound to `iam:passkeys.register`, and removing one, the last one
included, only with an assertion bound to `iam:passkeys.remove:<id>`. Otherwise a browser driven by someone else could
add an authenticator of its own and pass every later step-up. The first registration has no such check, so a stolen
session can register the first passkey of a person who has none. It is audited, and a reset removes it. A person who
can no longer answer with any passkey asks an installation administrator. The administrator removes every passkey of
that person: "Remove all passkeys" on the person's Sign-in tab, or `passkeys.reset` over `/admin/rpc`.

**Records.** `iam.passkey.register` and `iam.passkey.remove` are filed under the person, and `iam.passkey.reset`
under the administrator. Each is written in its change's own transaction. A verified assertion records only its use,
as the passkey's last-used time.

**The step-up seam** is `challenge` and `verify`. `verify` answers `{ principalId, credentialId, at }`: the person, the
passkey's WebAuthn credential id, and the time of the verification in epoch seconds. It answers only for a challenge
issued to the caller with the same binding, unused and unexpired. Deciding an approval of a category with
`stepUp: webauthn` (ADR-0050 §5) uses this seam. Control asks for a challenge bound to the item, and verifies the
approver's answer with the approver's console token. That decision check is not built yet. No token carries a
step-up claim, and the proxy is unchanged.

**Storage.** Two tables, in both migration sets (`0038_passkeys.sql`). `passkeys` holds the credential id, the COSE
public key, the counter, the transports and a label. `passkey_challenges` holds the open challenges and their bindings.
Neither holds a secret: a public key and a challenge authenticate nothing on their own. An existing installation gets
both tables empty on its next upgrade. No variable or generated file changes.

## Per-user state

Every user can have one password state:

- `disabled` — no password login is permitted;
- `pending` — an administrator enabled enrollment, but the user has not chosen a
  password;
- `enabled` — a password verifier exists and password login is permitted.

The Access user detail shows the global availability and per-user state of both
methods. Administrators can issue or reissue enrollment, issue reset for an
enabled account, and disable password login. They never set or read a password.

A principal's activation is independent of its OIDC subject. OIDC claiming or a
completed password enrollment activates an invited user. Services are active at
creation. Browser sessions record whether OIDC or password created them.
Replacing or disabling a password revokes password sessions only; valid OIDC
sessions remain active.

An operator lists and revokes a principal's sessions from the Access plane
(`sessions.list` / `sessions.revoke` / `sessions.revokeAll`). Revoking an IAM session
also ends every app session derived from it, because a child session is valid only
while its parent is — the lookup joins to the parent on every use, so it is one
statement rather than a sweep. An access token already minted stays valid for the
rest of its TTL; that bound is what local verification buys.

## User administration in the console

The user detail opens on **Access**, followed by **Sign-in**, **Activity** and
**Account**. Its identity and account status stay visible in every section.

- Access shows each assignment's application, role, scope, expiration and author.
  `grants.update` edits it within its original application, retaining its id and
  author. The change and its before/after audit record commit together. Editing
  also advances the principal's delegation revision, because it can remove authority.
- Permissions are resolved separately for each application through the token
  resolver. Disabled accounts have no usable permissions; their assignments remain.
  Cross-app assignments and bootstrap administration reach platform services only.
- Sign-in groups application sessions under their IAM sign-in, with pagination.
  `SessionDto.status` keeps the stored lifecycle; `unavailableReason` additionally
  reports an ended parent, a disabled account or a disabled sign-in method.
  Signing out everywhere covers every session, including those on other pages.
- Password links show their issue time, expiration and whether they are closed.
  A closed link can have been used, replaced or revoked; metadata cannot tell which.
  Connected OAuth clients can be inspected and disconnected by installation administrators.
- Activity distinguishes changes **to** the person (`subjectPrincipalId`) from
  actions **by** the person (`principalId`, the existing actor filter), and provides
  a separate sign-in decision history. Audit and connected-client reads require
  installation administration. Other controls reflect the same live management
  rules their IAM mutations enforce.

Access changes and sign-outs do not invalidate already issued access tokens;
their default lifetime is five minutes. Disabling an account keeps its sessions
as well as its assignments, so enabling it can restore an unexpired session.

## A browser already signed in

A browser that holds an IAM login opens an application its login has not used yet: IAM asks `Continue
as <label>` or `Use another account` before it hands the login to that application. It does not ask
when the login already holds a session there, or when the login is less than a minute old. `Use another
account` signs the browser out of every application, then shows the sign-in page for the same
application. See [Session handoff](cross-host-sso.md) for the rules.

## Enrollment and reset

Enrollment and reset share one action-token flow:

1. IAM creates a random, one-hour token and stores only its hash. The browser URL
   carries the plaintext in its fragment, which is not sent in HTTP requests or
   access logs; the action page copies it into the same-origin POST form.
2. With an email sender, IAM sends the action URL and the admin API returns the
   destination address and expiry.
3. Without a sender, the admin API returns the URL in that response only so the
   operator can copy it through a trusted channel.
4. A `GET` renders the form without consuming the token, so mail-link scanners
   cannot invalidate it.
5. The same-origin `POST` validates the password and atomically consumes the
   token, stores the verifier, activates the principal, and revokes older
   password sessions.
6. The answer signs the browser in to IAM. An action that keeps an application
   (below) then lands on that application's registered return origin, whose
   proxy completes the sign-in through the normal handoff without asking which
   account, because the login is new. Any other action lands on IAM's own origin.

Reset requests from `/auth/forgot-password` always return the same browser
response. They do not reveal whether the address exists, is disabled, has a
password, or is ambiguous. Self-service recovery is shown only when email is
available. Without email, an administrator issues a manual reset link.

Passwords are normalized to Unicode NFC. A new password must contain from the
installation's minimum to 256 Unicode code points. The minimum is 15 until an
installation administrator sets another (`passwordPolicy.set`, Settings →
Passwords in the console, audited as `iam.password_policy.update`); it applies to
every principal at the next enrollment, reset or invitation enrollment and never
to a stored password. It may go down to 4 on the Bun target and to 15 on a
Cloudflare Worker, whose verifiers are cheaper (backlog 201). A stored value
outside that range applies 15; a read that fails answers 500 and stores nothing. IAM rejects the 10 000
most common passwords (SecLists), a few Czech and long common ones, and exact
account-context values, whatever the minimum. It does not require character
classes. Stored verifiers
use versioned PBKDF2-HMAC-SHA256 parameters, a random per-password salt, and no
reversible password value.

Each composition root picks the PBKDF2 cost its runtime can derive. The Bun
target (Zerops) uses 600,000 iterations, the OWASP recommendation. The
Cloudflare Worker uses 100,000 iterations, because production Workers refuse
PBKDF2 above that count. workerd, miniflare and Bun do not enforce that cap, so
local runs cannot show the failure. A login rehashes a stored verifier whose
count differs from the runtime's cost, so verifiers converge. A verifier above
the runtime's cap, such as one that a Bun installation wrote, never verifies on
a Worker; that user resets the password. Local lopata and miniflare runs do not
enforce the cap either, so an account created locally before this cost applied
holds a 600,000-iteration verifier and cannot sign in until its password is
reset. Production Cloudflare never stored one, because hashing threw there.

Login failures are throttled by separate hashed account and deployment-wide
abuse keys. Recovery has separate account and deployment-wide buckets. Unknown,
ambiguous, disabled, and non-password users receive the same response and incur
password-derivation work until a bucket blocks; blocked requests skip the
expensive derivation.

A successful password login also sets a signed known-device cookie,
`__Host-fabrika_device` (`HttpOnly`, `SameSite=Lax`, 90 days), naming the
principal and a random device id. A later login that presents a valid one for
the SAME principal it targets skips the client, account and deployment-wide
buckets and spends a bucket of its own instead: 10 attempts in 15 minutes, after
which the cookie stops exempting until the block passes. Like the client bucket,
that bucket records the attempt before the password is checked and decides from
the row it wrote, so a parallel burst with one cookie gets no more than 10
checks; a successful login clears it. Its attempts count against none of the
three. A missing, forged, expired or other principal's cookie changes nothing.
So a client that fills any of those buckets cannot lock out a user signing in
again from a browser that signed in before.

Login and recovery each have a third bucket, keyed on a hash of the client
address, so one client cannot exhaust the deployment-wide bucket and deny the
installation. IAM does not derive that address: the composition root names the
one header its own ingress overwrites with the client's address —
`CF-Connecting-IP` on Cloudflare, where IAM sits behind the edge. An IPv6 client
counts by its /64, since one subscriber may hold every address of it; the
application runtime's client buckets use the same rule (`clientAddressKey` in
`@fabrika/auth-core`). An installation whose ingress cannot see the client names
no header and keeps only the account and deployment-wide buckets. The Bun target
on Zerops is one: behind the shared IPv4 the project balancer forwards no IPv4
client's address and keeps a caller-supplied `X-Forwarded-For` prefix
([platform facts](zerops-platform.md#public-access)), so `trusted_proxies` is
unset and the proxy's `X-Fabrika-Client-Ip` is the balancer for every client.
Keyed on it, the client bucket would be one installation-wide bucket that also
caps workload-token minting, so the Bun root names no header. A request on IAM's
port without the installation's proxy secret still shares one client bucket
(ADR-0022).

Unlike the other two, the client bucket counts every attempt rather than every
failure, decides admission from the returned row of the statement that records
it, and is not cleared by a successful login. Public forms use same-origin checks, an enforced 16 KiB
stream limit, safe redirect
validation, no-referrer and no-store headers, a restrictive CSP, and
frame-ancestor protection.

## Language and the application

IAM renders its pages (sign-in, forgot password, set password, invitation and
their outcomes, sign-out, terminal enrolment) and its own e-mails from a catalog
in `en`, `cs` and `uk`. An application chooses its language and its display name
with `locale` and `displayName` in its contract's vocabulary; IAM reconciles both
with the schema. The words stay IAM's, and every inserted value is escaped.

The application of a request is:

- a handoff sign-in's `?app=`; its forgot-password link carries the same app;
- an invitation's application, named in the mailed link;
- a password action's stored application: the one its forgot-password request
  came from.

An application IAM does not know, or one without a `locale`, has no language of
its own. Without a `displayName`, the sign-in and password pages and mails name
no application, and an invitation names it by its id. A link's `?app=` only
picks words; where a completed action or invitation lands is decided by the
stored application and its registered return origin.

### The person's language

A person may read IAM in a language other than their application's. The
inviting application names it on the invitation (`InvitationOptions.locale`,
`ctx.members.assign(ref, { email }, role, { locale: 'uk' })`), as one of the
languages above; IAM refuses any other (`invalid_request`). IAM then:

1. writes the invitation e-mail in it, and its link carries `&locale=` so the
   accept page, which knows no invitation before its form is posted, speaks it;
2. at acceptance keeps it as the principal's (`principals.locale`), for an
   existing principal and for one the acceptance creates;
3. writes the principal's later password e-mails in it, from IAM's own
   forgot-password page or an administrator alike, and keeps it on the password
   action (`password_action_tokens.locale`), so the set-password page and its
   refusals speak it too;
4. after each sign-in of a principal with a language of its own, remembers it
   for that browser in the host-only `__Host-fabrika_locale` cookie (one year,
   `HttpOnly`, `Secure`, `SameSite=Lax`), which the next sign-in page here
   reads; a sign-in of a principal without one clears it, so a shared browser
   does not keep the previous person's.

A resend that names a language replaces the stored one; one that names none
keeps it. An invitation that names none is written in the language the
mailbox's principal already has, else the application's. Every one of these is
a hint for words: none decides a landing, an origin or an authority.

The principal's language belongs to the person on the installation, not to the
application that named it
([ADR-0077](../decisions/0077-a-person-reads-iam-in-their-own-language.md)):
once an invitation that names one is accepted, IAM's pages and e-mails for every
application speak it, including one that declares a `locale` of its own. The
most recently accepted invitation that names a language replaces the stored
one. IAM tells no application which language a person keeps, and the
forgot-password page answers alike whichever it is. A principal's language is
removed with the principal.

A page takes its language from the first of these that names one IAM speaks:

1. the person's own, as IAM stored it for the flow (the invitation's, the
   password action's, the accepting principal's, and on the account question
   the signed-in principal's);
2. a link's or a form's `?locale=`, which the links and forms IAM builds for a
   person whose language it knows carry on, its own sign-in included (the
   return from an SSO provider does not), and which an application's proxy
   writes on its sign-in bounce from the application's own language cookie
   (below);
3. the remembered cookie, which a sign-in leaves and an invitation's "sign in
   first" sets to the invitation's language;
4. the application's `locale`;
5. the browser's `Accept-Language`, by weight, each range matched by its
   primary subtag (`uk-UA` is `uk`);
6. the installation's default, `en`.

An e-mail has no request, so it takes the person's language, else the
application's, else the default; a forgot-password e-mail to a person without a
language of their own is written in the language of the page that asked for it.
An application that declares a language shows every page it showed before; only
a language the person was given wins over it. An application that serves people
of several languages either names each person's on their invitation or declares
no `locale` and lets the browser choose. A stored value IAM no longer speaks
counts as none.

The sign-in an application's proxy starts names the language the application
left for the browser on its own host: an application may set the host-only
`__Host-fabrika_locale` cookie (`LOCALE_COOKIE` in `@fabrika/auth-core`; `Secure`,
`Path=/`, no `Domain`, as the prefix requires) to one of the languages above,
from its server or its page (`rememberSignInLocale` of `@fabrika/app/client`
writes it from an SPA), and the proxy adds that value to IAM's login URL as
`?locale=`. A value IAM does not speak is not passed on. The proxy decides
exactly as without it, on Cloudflare and Zerops alike, and the cookie reaches
the application with its other cookies. The helper keeps the cookie for a
year, but Safari keeps a cookie a script writes for seven days at most, so a
page that wants it longer calls the helper on each visit or lets its server
write the cookie.

An invitation's "sign in first" sends the browser to the application's
address, so the answer remembers the invitation's language in IAM's own cookie
and the sign-in page the proxy's bounce opens speaks it, unless the
application's own language cookie names another; the invitation link the
person then opens again speaks theirs too. Without either cookie,
on a browser where the person has not signed in yet, that page follows the
application's or the browser's language.

An application may also word IAM's e-mails itself with `mail` in its vocabulary:
per message (`invitation`, `enrollment`, `reset`) and language, a one-line
subject and a plain text with `{{name}}` placeholders from a closed set per
message. The text must place `{{actionUrl}}`, the link IAM builds. IAM fills the
placeholders, sends the text as filled, and builds the HTML part itself: the
escaped text as paragraphs and its own button to the link. The checker refuses
an unknown placeholder or a text without the link, and so does the reconcile.
IAM picks the template of the e-mail's language, the person's where it knows
one, so an application that serves people of several languages words each of
them. A message or a language without a template gets IAM's catalog wording.

A template may carry its own `html` body instead of IAM's, in a closed subset
(`mailHtmlTokens` in `@fabrika/auth-core`): text structure only, no attribute but
a link's `href`, and a link only to `{{actionUrl}}`, `{{appUrl}}` or a `mailto:`
address. IAM renders it from its tokens, never from its source, with every value
escaped. `{{appUrl}}` is built at send time from the application's first
registered return origin; a template that names it while no origin is registered
is sent in IAM's wording ([ADR-0019](../decisions/0019-portable-outbound-email.md)).

## Membership invitations

An application invites an address to a membership role through IAM's
`assignMember` (ADR-0012 §6). The address is verified by the invitation itself:

1. IAM stores a random token's hash with the application, the value, the role
   and the normalized mailbox, and mails a one-time link to
   `/auth/invitations/accept?app=<app>#token=…` (with `&locale=` when the
   invitation names the person's language). Repeating the invitation answers the open
   one and sends nothing. It expires after 7 days.
2. Without an email sender there are no invitations (`invitations_disabled`).
   Assigning an existing principal by id still works.
3. A `GET` renders the form without consuming anything; the page copies the
   fragment into the same-origin `POST` form.
4. The `POST` needs an IAM session on IAM's host. Without one the page asks the
   person to sign in and open the link again, unless no principal holds the
   invited mailbox and nothing would create one (the invitation does not create
   its principal, below, and single sign-on is off or its allowlist does not
   admit the mailbox): then the page says the address has no account here and
   to ask the inviter for one, and the invitation stays open. With a session,
   IAM accepts only when the signed-in principal's mailbox is the invited one,
   checks again that the inviter can still give the role, and then marks the
   invitation accepted and writes the grant in one transaction.
5. An accepted invitation lands on the application's registered return origin.
   Without one, IAM answers its outcome page.

An invitation may name the invited person's company (`label`, at most 200
characters on one line) and a personal message (at most 1000 characters of plain
text). Both reach the e-mail, IAM's wording and an application's
`{{companyLabel}}`/`{{message}}` alike, and are escaped in its HTML part. A
resend (`invitation.resend`) gives the open invitation a new link and a new
7 days and mails it again; the earlier link stops working.

IAM's e-mail says how the invited person accepts, as IAM can tell when it sends
(`invitationAcceptance`): choose a password when the invitation creates its
principal, sign in when a principal holds the mailbox or single sign-on would
admit it, and otherwise that the address has no account here yet. Only the first
promises a password. An application's own template is sent as written.

An application that invites people who have no account yet declares their role
`external` (below). Inviting a new mailbox to a role not declared external reaches
only a person an administrator, or single sign-on, gives an account.

### An invitation that creates its principal

An invitation to a role the application declares `external` (ADR-0051), for a
mailbox no principal holds, onboards a person IAM does not know. Nothing is
created when it is sent. When the mailbox's owner opens the link and accepts,
IAM answers a set-password form instead of asking them to sign in, provided the
installation enables password authentication and e-mail and the inviter can
still give the role. That form's `POST` creates the external principal, its
enabled password (same policy and verifier as enrollment), its grant, consumes
the invitation and writes the records, in one transaction, then signs the
browser in to IAM and lands it on the application, whose proxy completes the
handoff. This enrollment lives as long as the invitation, 7 days (ADR-0020).

- A mailbox some principal holds keeps the sign-in-and-accept steps above. An
  invitation never sets, replaces or re-enables an existing principal's
  password, a disabled principal's included.
- A mailbox the organization names — a bootstrap admin, an exact
  `HUMAN_EMAILS` entry or a `HUMAN_EMAIL_DOMAINS` domain (`*` names nobody) — is
  never created as an external: inviting it to an external role is refused with
  `internal_mailbox`.
- Two acceptances that would create the same mailbox create one principal; the
  other person signs in with it and accepts.
- A browser signed in on IAM as anyone gets no set-password form: the page
  names the invited address and asks the person to sign out or open the link
  in another browser profile. Nothing is written and the link stays valid.
- Every acceptance, this one and a signed-in one, writes only while the
  inviter is still enabled and holds its assigning role, and the application's
  schema is at the revision its check read. A reconcile, a disable or the
  removal of the assigning grant in between makes it write nothing, and the
  invitation stays open. Removing another grant of the inviter's that supplied
  one of the role's actions is not serialized with it.

## Terminals

A terminal is a shared computer, an enrolled browser, on which an application identifies a person in its own way (a
PIN, a key fob) and IAM signs that person in
([ADR-0067](../decisions/0067-a-terminal-signs-a-person-in-on-an-application-s-word.md)).

- **Enrolment.** A person holding `iam.terminals.manage` opens `/auth/terminals/enroll` on the computer and names it.
  IAM creates a `service` principal with a `terminals` row and sets `__Host-px_terminal` on IAM's host (random, stored
  as a hash, `HttpOnly`, `SameSite=Lax`, 400 days). In the same batch it revokes the enrolling login on that browser
  and writes an audit event. The cookie is not a session: no proxy reads it, and IAM reads it only to open an
  identification.
- **Profile.** `terminals.setProfile` on `/admin/rpc` (`iam.admin`) sets the label, `sessionTtl` (1–3600 s, default
  300) and the asserters: the applications that may assert a person on the terminal, each with its **ceiling**, a list
  of action patterns. Grants on the terminal's principal (`grants.create`) are what the terminal adds.
  `terminals.list` lists terminals; `terminals.revoke` ends every session issued on one.
- **Identification.** The proxy bounces to `/auth/login` as for any sign-in. A personal login on the browser wins.
  Otherwise, with a valid terminal cookie, the application among its asserters and an identification page declared,
  IAM opens an identification (single use, two minutes, holding the handoff) and redirects to
  `<return origin><identify>?identification=<id>`. In every other case IAM shows the normal sign-in.
- **Assertion.** The application's public procedure calls `inspectIdentification`, `assertIdentity` and
  `cancelIdentification` over its membership transport, with a token whose `aud` is the application. IAM takes the
  application from the transport, never from the input: the membership transport key, or on Cloudflare the
  `props.app` that the deployer writes on the application's `IAM` binding. `assertIdentity` accepts only an active internal user. It
  consumes the identification, writes a login with `authentication_method = 'terminal_assertion'`, the terminal and
  the terminal's TTL, and no cookie, and returns IAM's completion URL, `/auth/terminals/complete?identification=<id>`.
  It carries no code.
- **Completion.** The application sends the browser to the completion URL. IAM issues the handoff code there, once and
  within a minute, only to the browser that holds the cookie of the identification's own terminal, and only while the
  asserted login is still valid. It 302s to the proxy's callback, and the proxy redeems the code with the verifier it
  set at the bounce. An application never holds a code. A proxy that receives a code without its verifier spends it.
- **What the session may do.** The token carries the person's `sub`, `amr: 'terminal_assertion'` and
  `terminal: { id, label }`. Its permissions are the person's own, narrowed by the ceiling (a person's `*` under a
  ceiling `a.read` keeps `a.read`), plus the terminal principal's, with source `terminal`. An empty ceiling, the
  default, keeps only the person's identity. The session mints only for the asserting application, never for a
  platform audience.
- **Sign-out.** The application sends the browser to its own `/__fabrika/auth/signout?redirect=<path>` (a same-origin
  `GET`). The proxy clears the session cookie and its cached token and redirects to IAM's
  `/auth/terminals/release`. IAM checks the return address against the application's return origins, revokes the
  terminal's active sessions and sends the browser back. The next request bounces and opens a new identification.
  The session TTL is the backstop when nobody signs out.
- **Throttling** guesses is the application's duty; `inspectIdentification` names the terminal to key it on. Every
  `auth_log` row of the flow carries `terminal_id` and `asserted_by`.

An application declares `terminal: { identify: '/path' }` in its vocabulary, a path that a public SPA mount serves.
Its procedures then get `ctx.terminals`, and a person's `ctx.principal.terminal` names the terminal
([Application runtime](application-runtime.md#membership-share-links-and-the-anonymous-kinds)).

## First administrator

`IAM_BOOTSTRAP_ADMINS` authorizes an email only after identity is proven. It is
not a password and does not create a principal by itself.

For a password-only installation with email, requesting recovery for one exact
configured bootstrap mailbox can create its invited principal and send the first
enrollment action. Comparison is case-insensitive over the complete mailbox; it
does not apply domain or wildcard admission rules.

Without email, the existing `FABRIKA_IAM_PROVISIONING_KEY` bearer calls the IAM
admin RPC to invite the first user and issue a manual enrollment link. The same
path is used for later manual enrollment. Fabrika does not store or print a
bootstrap password.

## First machine caller

`FABRIKA_IAM_PROVISIONING_KEY` authenticates against IAM's own `/admin/*`
surface, which is not behind the proxy. It is **not** a credential for any other
service. It has no `credentials` row, so `mintFromKey` cannot resolve it, and the
proxy refuses it with `invalid_key` before the request reaches the application
behind it.

A machine that calls the control plane, Operations, or any deployed app uses an
**IAM-issued service key**: an operator (or CI, once bootstrapped) provisions one
through IAM's admin surface with the provisioning key, and the resulting `px_…`
credential is what the proxy exchanges for an access token. The local stack does
exactly this and stores the result in `.state/machine.env`.

A service key is bound to the app it was provisioned for. Provisioning it with no
`app` makes it cross-app, which is the right choice for an operator credential
that drives several planes and the wrong one for an integration that needs only
one. A cross-app grant reaches only the installation's own services (IAM, the
console, Operations): a token for an application `<app>@<env>` carries the grants
of that id and nothing else, and neither does the bootstrap `admin`
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) rule 6).

A service key's permissions are the grants of its service principal, and IAM reads them at every token exchange. To
change what a key may do, an installation administrator adds, edits or removes a grant on the key's page in the console
(Access → Credentials → the key), or calls `grants.create`, `grants.update` and `grants.delete` on its principal. An edit
changes the grant's role or actions, scope and expiry in place, keeps its app, and is audited as `iam.grant.update` with
the values before and after. The key keeps its secret, so nothing is redistributed. The same rules apply as at
provisioning: a registered app, a known role or catalog actions, and no wildcard at a contract application. A user
administrator cannot do this
([ADR-0058](../decisions/0058-user-administration-is-grantable-on-its-own.md) section 4). The change applies at the
key's next exchange. A caller that already holds a token, the proxy's cached one included, keeps the old permissions
until that token expires, at most five minutes. A grant at an app other than the one the key is bound to never reaches
its token, so the console offers only that app.

See [ADR-0020](../decisions/0020-compose-human-authentication-methods.md) for the
decision and rejected mode/temporary-password alternatives.

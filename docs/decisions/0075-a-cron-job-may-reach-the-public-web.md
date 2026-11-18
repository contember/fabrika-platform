---
id: 0075
title: A cron job may reach the public web
status: proposed
date: 2026-10-25
---

# 0075 — A cron job may reach the public web

## Context

A site's `egress` names the exact HTTPS origins its code calls, at most 16
([ADR-0012](0012-fabrika-app-runtime.md) §15). While the handler runs, a guard on the global `fetch` refuses every
other origin (`undeclared_egress`), the checker's `cross-app-fetch` accepts only a declared origin, and the approver
sees each one ([ADR-0050](0050-approved-access.md)).

Some applications call hosts nobody knows when the contract is written. A crawler or auditor of operator-entered
sites fetches the websites its operators enter in its UI (their `www` variants and redirects included) and calls a
third-party analysis API. A static list cannot hold them, and the ways around the guard are worse: code that keeps the
`fetch` it found before boot escapes it, which is exactly the hidden reach the skill forbids, and a second Worker beside
the contract's is refused by the Cloudflare bounds.

Opening `fetch` to arbitrary hosts is a server-side request forgery risk. The forces:

- **The installation's own surfaces.** IAM, Control, Operations and every application environment answer on public
  hosts. A request to one of them from an application's job is not a request from the internet: the job runs inside
  the installation, and on Zerops inside its private network.
- **Private networks.** On Zerops an application shares a project's private network with its database, its object
  store and, behind a namespace, its proxy and other applications. Internal service names have one label, and a public
  name can resolve to a private address. Cloud metadata answers at `169.254.169.254`.
- **The runtimes differ.** A Bun process can resolve a name and then connect to the address it checked. A Worker can
  resolve a name too (`node:dns`, over DNS over HTTPS), but its `fetch` resolves the name again inside Cloudflare's
  network, so no answer the Worker checks decides where the request goes. That `fetch` leaves through Cloudflare's
  network, not the installation's.
- **Redirects.** The runtime follows a redirect inside `fetch`, after the guard has admitted the first URL, so a
  public page can redirect a job anywhere.
- **Holding the environment.** On Cloudflare a procedure waits for an outside call inside the object's transaction
  ([ADR-0065](0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)), and a crawl takes
  minutes.
- **The protocol.** The contract artifact is protocol between the application and the platform
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)), so a new form must be additive.

## Decision

**A cron job may declare `egress: 'public'`: its code reaches any public host over HTTPS or HTTP, on the scheme's
default port. The guard refuses the installation and private networks, checks every redirect hop, and bounds each
request. Gaining it is a widening for closer review.**

### 1. The declaration

- **A cron job only.** `app.cron(schedule, { actions, egress: 'public' })`. A procedure, a mutation and a webhook name
  their origins: the build refuses `'public'` there, and the types do too. A job runs outside any transaction, and its
  schedule or a kick, not a caller, decides when it runs. A procedure that crawls on a caller's request would be a
  fetch proxy for that caller.
- **One form, not a wildcard.** `'public'` replaces the list; a job declares one or the other. HTTP is included,
  because the websites an auditor checks still answer on it and redirect from it.
- **In the artifact.** `declared['job:<name>'].egress` holds `'public'` instead of a list. The artifact format stays
  2: older artifacts never hold the value, so their canonical form and digest are unchanged, and the release that adds
  the form reads them as they are (release-process "Artifact formats").

### 2. What the guard refuses

Before each hop, and so again after each redirect:

- **By the URL** (`publicEgressRefusal` in `@fabrika/auth-core`, which the checker shares): a scheme other than
  `https:` and `http:`, a port other than the default, credentials in the URL (`user:pass@`), every IP literal (a public one too: a website has a name), a
  name of one label (`localhost`, `iam`, a Zerops service), and every name under `localhost`, `local`, `internal`,
  `intranet`, `lan`, `home`, `corp`, `private`, `arpa`, `test`, `invalid`, `example`, `onion`, `alt`, `zerops`,
  and the platform subdomains an installation is served on beside its own domains: `workers.dev`, where its Workers
  have their default routes, and `zerops.app`, where its namespace proxies (`proxy-…-8080.<region>.zerops.app`),
  Control and IAM have theirs. Control holds no list of those subdomains, so every one is refused, another
  installation's and a stranger's site on `zerops.app` too; a name with an empty label (`a..b`) is refused, and
  trailing dots are dropped before any comparison.
- **By the installation's hosts.** Every host a framework variable of the environment names (IAM's issuer and RPC
  URL, the Operations DSN, the environment's own origin, the platform's receivers, the object store), and the hosts
  Control hands as `FABRIKA_EGRESS_REFUSED_HOSTS`: Control's, IAM's, Operations' and every environment's domain and
  public origin. A host matches exactly; its subdomains are other hosts. The list is the registry at the deploy: a
  domain another application gains later is refused from this environment's next deploy, and the approval line says
  so. Every such domain sits behind its proxy, which admits the job as it admits anyone on the internet.
- **By the address, where the runtime resolves.** The Bun adapter resolves the host (`node:dns`, every address) and
  the guard refuses a name with any address that is not public unicast: private, loopback, link-local (the metadata
  address), shared (CGNAT, which holds Alibaba's metadata address), multicast, reserved, documentation, IPv6 forms that
  carry an IPv4 address it cannot vouch for, and Azure's host endpoint `168.63.129.16`, a public address that answers
  inside the VM. A Worker passes no resolver: an answer it checked would not pin its `fetch`.
- **Then connects to the address it checked.** A hop the resolver admitted is sent to the checked address (IPv4 first:
  a container without an IPv6 route still connects), with the checked name as `Host` and as the TLS `serverName`, and
  `keepalive: false`. Bun sends that `Host`, checks the server's certificate against the `serverName`, and under
  `keepalive: false` takes no pooled connection; Bun keys its pool by address and port, so a pooled connection may have been checked against another
  name's certificate. The name is resolved once per hop, so an answer that changes after the check (DNS rebinding)
  reaches nothing. `public-egress-pinning.test.ts` holds the pinned Bun release to all three behaviours.

A refusal is `capability_refused: refused_egress`, and the job fails with it.

### 3. Redirects and bounds

- **Every hop is sent with `redirect: 'manual'`.** For the caller's `follow` the guard follows at most 10 redirects
  itself, checking each target; a 303, and a 301 or 302 of a `POST`, turn into a `GET` without the body; another
  origin loses `Authorization`, `Proxy-Authorization` and `Cookie`. The caller's `manual` gets the redirect, and its
  next `fetch` passes the guard again. `error` refuses one.
- **No caller-set routing headers.** Every hop drops the Fetch standard's forbidden request headers (`Host` among them,
  which would send a request for a public name to another site behind the same address), `Forwarded`,
  `X-Forwarded-*`, `X-Real-IP`, `Proxy-*`, `Sec-*` and `X-Fabrika-*`, in `follow` and in `manual` mode alike.
- **Only the global `fetch`.** A preconnect under public egress is refused, since no hop can be checked before it
  connects. A site with origins passes only the Fetch standard's fields of its `init`, so Bun's `unix`, `proxy` or
  `tls` cannot send a request to an admitted origin elsewhere. The checker refuses `Bun.fetch` and `WebSocket`, which
  the guard does not see.
- **60 seconds per request**, its redirects and the reading of its body included, beside the caller's own signal.
- **16 MiB per response body**, by its `Content-Length` or as it arrives (`capability_refused: oversized_egress`). The
  guard reads the body whole before the caller gets the answer: Bun buffers a body as it arrives whether or not anyone
  reads it, and cancelling the body's reader leaves Bun downloading it, so the guard aborts the hop's request at the cap
  (and when it drops a redirect's body), which closes the connection. An answer with a status outside 200–599, which
  Bun passes on and a `Response` cannot carry, fails the request the same way.
- **No compressed body.** Every hop asks for `Accept-Encoding: identity` and, on Bun, turns off the runtime's own
  decoding (`decompress: false`), which grows a body natively without bound (a 64 KiB gzip answer decodes to 64 MiB
  before any reader sees it). An answer whose `Content-Encoding` is anything else is refused unread
  (`capability_refused: encoded_egress`). A server must honour `identity` (RFC 9110); one that does not is out of
  reach. Decoding with a bound of the guard's own would need a streaming decoder whose output it can meter, which
  neither runtime offers for every encoding.
- A site that declares origins keeps today's guard: exact origins, the runtime's own redirect handling, no bounds.

### 4. Review

- The approval diff shows gaining `'public'` as one line for closer review, "calls any public website over HTTPS or
  HTTP", instead of a line per origin. The line says that whoever can write the rows the job reads, or the pages it
  fetches, can make it fetch any public URL and read the answer (a stored, blind request proxy), and that a domain
  added later is refused only from the next deploy. Losing it narrows, but each origin the job lists instead widens
  with closer review: the origin guard admits an IP address, a port, the installation's hosts and a name that resolves
  privately, all of which `'public'` refuses, so no listed origin is provably within the reach it replaces. The
  environment's "off the paved road" list shows `'public'` while it is published.
- The checker's `cross-app-fetch` accepts, where some job declares `'public'`, a static URL prefix of http(s) whose
  host is not yet complete or that the URL rules admit. It still refuses one they refuse, such as `http://localhost/`.

### 5. What is enforced where

| Check                                          | Bun (Zerops, local)                    | Cloudflare object                                                                                                |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Scheme, port, IP literal, refused name suffix  | guard                                  | guard                                                                                                            |
| The installation's hosts                       | guard                                  | guard                                                                                                            |
| Credentials in the URL                         | guard                                  | guard                                                                                                            |
| A public name of a private address             | guard, at each hop                     | not checked by the guard (no resolver): an installation on Cloudflare has no private network or metadata address |
| Each redirect hop                              | guard                                  | guard                                                                                                            |
| Time and body bounds                           | guard                                  | guard                                                                                                            |
| DNS rebinding between the check and connecting | guard: connects to the checked address | not applicable: the guard resolves nothing                                                                       |
| Code that bypasses the guard                   | not prevented (ADR-0012 §8)            | not prevented (ADR-0012 §8)                                                                                      |

The guard is still no sandbox. It stops a mistake and a page that points a crawler at the installation; it does not
contain code written to escape it.

## Consequences

- An application that crawls operator-entered websites runs on the paved road: one declaration, one review line, no
  second Worker and no captured `fetch`.
- The approver must treat the line as broad: the job's code can send what it holds to any public host. That is why
  only a job declares it, and why it is a closer review.
- Control computes `FABRIKA_EGRESS_REFUSED_HOSTS` at each deploy of a contract with such a job, from its registry, and
  hands `null` to every other deploy, which removes a stale list. A host added later (a new application's domain) is
  refused from that environment's next deploy on. The hosts the environment's own variables name are refused from the
  start.
- **Rollout on an existing installation.** The variable is a managed variable, written by each deploy like
  `FABRIKA_APP_ORIGIN`: no generated file and no provider state changes, and `fabrika platform upgrade` needs no step.
  An application on an older framework release never declares the form and ignores the variable.
- On Bun each hop costs one name resolution and a fresh connection: a crawl reuses no connection between its requests.
  The pinning relies on how Bun's `fetch` treats `Host` and `keepalive`, which is not part of the Fetch standard; a Bun
  upgrade that changes either fails `public-egress-pinning.test.ts`.
- On Cloudflare the guard has no resolver and checks no address. A Worker's subrequest leaves through Cloudflare's
  network, and an installation there has no private network or metadata address for a public name to point at; the
  URL rules and the installation's hosts still hold.

## Alternatives considered

- **A wildcard in the origin list** (`'https://*'`, `'https://*.example.com'`). It reads as a narrower declaration than
  it is, and a list of patterns still cannot name hosts an operator enters later.
- **A larger origin limit.** The hosts are data, entered at runtime; no limit fits them.
- **A second Worker for the crawl, outside the contract.** The Cloudflare bounds allow one application Worker per
  deployment, and the crawl would leave the review entirely.
- **`'public'` on any site that declares egress today.** A query or a mutation that fetches a caller's URL is a
  request-forgery proxy for that caller, and on Cloudflare a mutation would hold the whole environment while it waits.
- **Resolving, checking, then letting `fetch` resolve again.** Simpler, but a name whose answer changes between the
  two lookups reaches a private address. Connecting to the checked address closes that on Bun.
- **Resolving names over DNS-over-HTTPS on Cloudflare.** It would check an answer Cloudflare's own connection does not
  use, against a network that holds nothing private of the installation.
- **Refusing only private IP literals and leaving names to the runtime.** On Workers that would be enough, since no
  private network is reachable; on Zerops it is not, because a public name can resolve to a private address. Refusing
  every IP literal, and resolving names where the runtime can, holds on both.
- **Suffix-matching the installation's hosts** (refusing every subdomain of IAM's domain). An installation often sits
  on its client's own domain, which the client's auditor must still reach.

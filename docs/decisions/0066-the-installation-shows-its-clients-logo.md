---
id: 0066
title: The installation shows its client's logo
status: accepted
date: 2026-10-20
---

# 0066: The installation shows its client's logo

## Context

One installation serves one client. The people who meet fabrika's own pages are that client's users: IAM's sign-in,
password and consent pages, and the proxy's pages on every application host (a refused request, a missing page, a
failed sign-in callback, an application that does not answer). Those pages carried fabrika's mark, which tells a
client's user nothing about where they are. The console is the operator's tool and is not one of them.

What already holds and must keep holding:

- **The proxy is the only enforcement point** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)), and its
  manifest parser is strict: it refuses any key it does not know, so a proxy built from an older source refuses a
  manifest with a new field.
- **A Zerops proxy reads its manifest once, at build**, from the data file of its build archive
  ([ADR-0045](0045-upload-immutable-platform-and-namespace-proxy-sources.md)). A change of the manifest is a rebuild of
  about four minutes. The proxy has no store and makes no call per request beyond IAM's `forward_auth`.
- **IAM's pages are served under a CSP of their own** (`default-src 'none'`, nonced style and script), and IAM
  answers its own pages without Control.
- **A Cloudflare proxy Worker carries its manifest as a variable**, which Cloudflare caps at 5 KB
  ([backlog 177](../backlog/177-the-cloudflare-proxy-manifest-is-a-worker-variable.md)).

## Decision

**We will let an installation administrator set one client logo per installation, keep it in IAM, and draw it on
IAM's pages and on the proxy's pages of every application. The console, and Control's GitHub handoff, keep fabrika's
mark. Every page keeps the footer "Runs on fabrika", with no link.**

1. **IAM owns the logo.** It is one row (`0021_installation_brand.sql`, both dialects): a light image and an optional
   dark one. `brand.get`, `brand.set` and `brand.clear` on IAM's admin RPC require the installation's IAM
   administration (`iam.admin`); a user administrator ([ADR-0058](0058-user-administration-is-grantable-on-its-own.md))
   is refused. Every change is audited as `iam.brand.update`. `brand.clear` keeps the row with its images removed, so
   `updatedAt` still says when the logo went; an empty table also means no logo.
2. **An image is PNG, WebP or SVG, at most 32 KB, held to one check.** `@fabrika/proxy-core/brand`
   (`brandImageProblem`, `installationBrandSchema`) checks the type by its magic bytes, the size of each variant, and
   canonical base64. IAM's input schema, the proxy's manifest parser and the console's file picker use that one
   function. A wide wordmark and a square symbol both fit the space the pages give it.
3. **The proxy reads it from its manifest.** A manifest may carry one top-level field besides its entries,
   `brand: { light, dark? }`. It grants and refuses nothing: no decision reads it, only the page renderer. Each page
   embeds it as a `data:` URI inside `<picture>`, the dark variant under `prefers-color-scheme: dark`. In Caddy the
   page bodies are `named_routes`, so a 32 KB logo is in the configuration once per page and not once per
   route.
4. **Control carries it from IAM to the provider.** Control reads it with the provisioning key once per namespace
   mutation (provision, reconcile, republish) and hands it as `ProviderNamespaceMutationInput.brand`. The logo is
   presentation, so a read that fails, or that IAM leaves unanswered for five seconds, publishes fabrika's mark and
   logs a warning; it never fails the mutation. A
   namespace that failed for a logo would refuse every deploy, and a republish carries the registry's routing, which
   is authorization state the proxy must receive (ADR-0022). The next publish draws the logo again.
   `namespaces.republishAll` (`namespace.manage`), which the console calls after a change, is the exception: it reads
   the logo once and refuses when IAM does not answer, because the change it was asked to publish would reach no proxy.
   It republishes every ready namespace with it; one whose lease a deploy holds is no failure, since that republish
   queues a reconcile that publishes after the deploy. One still mid-change may have read the logo before it changed,
   so it goes back to `pending` with a reconcile queued, which reads the logo again after the running job.
5. **A Zerops proxy gets it only from a source that accepts it.** The generated proxy build declares the literal
   variable `FABRIKA_PROXY_MANIFEST_BRAND`. The provider writes `brand` into the manifest only when the namespace's
   pinned descriptor carries it (`zeropsProxyAcceptsBrand`), so a namespace pinned to an older source keeps fabrika's
   mark instead of failing its build. The logo is part of the manifest digest, so a new logo rebuilds the proxy.
6. **IAM's pages admit `img-src data:` and nothing more.** IAM draws the logo itself on every page it serves, and on
   the OAuth consent and error pages. A failed read, or a stored row that fails the check, draws fabrika's mark and
   logs the message only: a failed read on every page, a refused row when it is checked and then once an hour while
   the pages read it. Every page reads the row, but the check runs again
   only when its images differ from the ones this IAM instance checked last: the key is the images themselves, so a
   change made on another instance is checked when this one first reads it. The installation's own proxy, in front of IAM and the console, keeps fabrika's mark on its
   pages, its 502 among them: its manifest is written at install, and when IAM does not answer nothing can ask it for
   the logo.
7. **Cloudflare comes after backlog 177.** The proxy Worker already draws a manifest's `brand`, but Control does not
   send one there: two 32 KB images do not fit a 5 KB variable. When the manifest is baked into the bundle, the
   Cloudflare provider takes `brand` the way the Zerops provider does.

## Consequences

- **A client's user sees the client's logo** on every page fabrika serves them, and the operator still sees fabrika's
  console. The pages share one frame (`@fabrika/proxy-core/page-style`), so one logo fits all of them.
- **A logo change reaches IAM at once and the applications in minutes.** On Zerops each namespace rebuilds its proxy;
  the console says so after a save.
- **An IAM outage can take the logo off a proxy until its next publish.** A deploy or a registry change that
  republishes while IAM does not answer publishes fabrika's mark. That is the price of never holding up a deploy or an
  authorization change for a picture; IAM's own pages fall back the same way.
- **A logo is a configuration value, bounded.** Two 32 KB variants make the Zerops manifest about 90 KB larger at
  most, which the archive data file carries without strain. Raising the limit means checking the Cloudflare variable
  and the Caddy configuration size again.
- **`img-src data:` on IAM's pages admits an image and nothing else.** A `data:` URI loads nothing from the network
  and an image runs no script; an SVG drawn through `<img>` runs none either. The style and script policy is unchanged.
- **Rollout of an existing installation.** IAM's migration adds the table on upgrade; every page is unchanged until an
  administrator sets a logo. `fabrika platform upgrade` rewrites the root `zerops.yaml` with the marker, but a
  namespace proxy keeps the descriptor it is pinned to: it shows the logo only after
  `fabrika control namespaces update --namespace=<id> --proxy-source=current`, and fabrika's mark until then. No
  environment variable changes. A namespace without a logo publishes the manifest it published before, byte for byte.

## Alternatives considered

- **Control owns the logo.** Control publishes the manifests, so it would need no second read. It lost because IAM
  draws its own pages without Control, and IAM's sign-in page is the one every user sees first: IAM would have to ask
  Control per page, or keep a copy that drifts.
- **Control keeps a copy of the logo** and reads IAM only when the console republishes. Each namespace mutation would
  save one provisioning-key call to IAM, with its `iam.admin.access` row and up to two 32 KB images, beside the calls a
  deploy already makes. It lost because the copy would change only with `republishAll`: a change saved by an
  administrator without `namespace.manage`, or one whose republish IAM left unanswered, would never reach a proxy, and
  every later deploy would publish the old logo. Reading IAM per mutation, every publish converges on what IAM holds.
- **The proxy fetches the logo at runtime.** One logo for every namespace, changed without a rebuild. It lost because
  the proxy has no store, and a fetch at the moment it shows an error page (often because something upstream is down)
  is the fetch most likely to fail. It would also be a second request path out of the proxy beside `forward_auth`.
- **A second file in the proxy's build archive.** The manifest would stay small. It lost because the archive carries
  exactly one generated data file (ADR-0045), and a second one would need its own digest, its own refusal of a commit
  that holds its path, and its own capability gate, for nothing the manifest field does not already give.
- **A reserved path on every application host serving the image** (`/__fabrika/brand`). Pages would reference it by
  URL and stay small. It lost because it reserves one more path in every application's namespace, needs the image to
  reach the proxy anyway, and fails on exactly the pages whose upstream does not answer.
- **The console carries the client's logo too.** It lost by the client's own measure: the console is the operator's,
  and it stays fabrika's.

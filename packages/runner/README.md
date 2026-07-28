# @fabrika/runner

The CI / container deploy runner: a containerized entrypoint that pulls a deploy job, builds the
app, and runs `@fabrika/engine`'s `deploy()` in an isolated environment.

> **Status: placeholder (M0).** The `Dockerfile`, the job entrypoint, and the `@fabrika/engine`
> wiring arrive in **M2**. Nothing runs here yet.

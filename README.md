# pilot-reference-ecs-v1

The repository this product is meant to deploy, written to be **run** rather than to be scanned.

An HTTP API and a queue consumer over PostgreSQL and a TLS-only Redis. Both services are built
from their own context with their own lockfile, both read the environment contract Pilot's
generator actually binds, and the work they do is observable as a row in a database rather than as
a log line.

## Why it exists

Every correspondence check in this repository so far compares one model against another: the
decision engine against the composer, the bill against the generated Terraform, the generated
Terraform against a specification. All of that can be internally consistent and still describe a
deployment that does not come up. This is the fixture that is supposed to come up.

The scenario is the one the execution plan names as the entry gate: one serving service, one
worker, a database holding a persistent record, and a cache reached over TLS by a real queue
client.

## What is here

```
services/api/       express, pg, ioredis, bullmq — health, enqueue, read result
services/worker/    bullmq consumer — computes and writes the result row
compose.yml         db + TLS cache + api + worker, loopback-only
EXPECTED.md         what a run must show, written before the harness
```

`EXPECTED.md` is the specification. It was written first and is not derived from the harness: a
specification read off the code it checks is a description, and a description passes whatever the
code does.

## Running it

```
npm run smoke:reference
```

The harness generates a throwaway certificate authority, brings the stack up, checks every claim
in `EXPECTED.md` including the refusals, and removes everything it created.

**It needs a container runtime.** Without one it exits `2` and reports `NOT EXECUTED` rather than
passing: a check that did not run is not a check that succeeded, and a silent skip is how an
unproven scenario comes to be described as proved.

## What the environment contract is, and why

The API reads `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` and `REDIS_URL`. Those are
the names the generated ECS task definition binds — the credential as a Secrets Manager reference,
the cache as one URL carrying its scheme.

An application reading `DATABASE_URL` instead is a common and reasonable shape, and Pilot refuses
it with `unresolved-connection-binding` rather than composing the URL in Terraform, which would
put the password into the module, the state file and the plan output. The reference reads what is
bound so that the scenario exercises the supported path; the unsupported one is covered by that
refusal and by its own tests.

The cache URL is passed to ioredis positionally and unmodified. Rewriting the scheme, or passing
`host:` with a `tls:` option the client does not read, is what the transport checks refuse — so
the reference does neither.

## What a passing run establishes, and what it does not

It establishes that these connection semantics work: a TLS-only cache, a real queue client, a
database write by a separate process, and a set of refusals that fail for their own reasons.

It establishes nothing about AWS. No image is pushed, no plan is applied, no ECS task runs, and no
statement here should be read as cloud evidence. The generated pipeline's identity boundaries are
repository and account settings and are not observable from this stack at all.

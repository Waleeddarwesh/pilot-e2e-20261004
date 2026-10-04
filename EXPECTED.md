# What a run of this scenario must show

Written before the harness, and deliberately not derived from it. A specification produced by
reading the code it checks is a description, and a description passes whatever the code does.

Every row below is something an operator could confirm by hand with `docker compose`, `psql` and
`curl`. Nothing here is satisfied by a process starting, by a log line, or by an HTTP `200` that
touched no data store.

## The stack

| # | Claim | How it is confirmed |
| --- | --- | --- |
| S1 | Four containers run: `db`, `cache`, `api`, `worker` | `docker compose ps` lists four services, all running |
| S2 | Both images are built from this repository, not pulled | `api` and `worker` have a `build:` context and no `image:` |
| S3 | The cache accepts **no** plaintext connection | `redis-cli -p 6380 ping` without `--tls` fails; with `--tls --cacert` it answers `PONG` |
| S4 | Nothing is published to the host at all | the resolved composition declares no published port; the harness reaches the containers with `exec` |

## The application

| # | Claim | How it is confirmed |
| --- | --- | --- |
| A1 | Health reflects the data stores, not the process | `GET /health` returns `200` with `checks.database` and `checks.cache` both true |
| A2 | Health fails when a store is unreachable | with `cache` stopped, `GET /health` returns `503` and names the failing check |
| A3 | The database holds the schema the worker writes to | `job_results` exists with `id`, `input`, `value`, `completed_at` |
| D1 | The database refuses a plaintext client and answers a verified one | connecting with TLS disabled is rejected by the server; the same client with `verify-full` and the CA connects |
| D2 | A certificate the client cannot verify is refused | given the wrong authority, the connection fails on the certificate rather than succeeding |

## The work

| # | Claim | How it is confirmed |
| --- | --- | --- |
| W1 | A job can be enqueued | `POST /jobs {"input": 7}` returns `202` and an id |
| W2 | The worker consumes it, and the result route serves it | within the budget, `GET /jobs/<id>` returns `200` — asked of the application, not of the database |
| W3 | The two views agree | the HTTP response carries `id`, `input = 7` and `value = 49`, **and** the row read directly from PostgreSQL carries the same |
| W4 | The result came from the worker, not the API | the API never writes `job_results`; the row exists only after the worker logs the job |
| W5 | A redelivered job is processed again and leaves one row | `POST /jobs/<id>/replay` re-adds the same job id; the worker logs completing it a **second** time; the table still holds one row |

## The refusals

A scenario that only shows the happy path shows that something worked once, not that anything is
checked. Each of these must fail, and fail for its own reason.

| # | Control | Required outcome |
| --- | --- | --- |
| R1 | `api` given `REDIS_URL=redis://cache:6380/0` (plaintext scheme) | the container does not become healthy; the connection is refused by the cache |
| R2 | `api` started without `NODE_EXTRA_CA_CERTS` | TLS fails on an unknown issuer rather than connecting insecurely |
| R3 | `api` given a wrong `DB_PASSWORD` | startup fails; the service never reports healthy |
| R4 | `worker` stopped | `POST /jobs` still returns `202` and `GET /jobs/<id>` stays `404` — an unconsumed queue is visible, not silently successful |

## Cleanup

| # | Claim | How it is confirmed |
| --- | --- | --- |
| C1 | Nothing **this run created** survives it | after teardown, three successful inventories — containers, networks and volumes, each filtered to this run's own project — come back empty |
| C2 | The test CA is not left behind | the scratch directory holding the certificates is removed |
| C3 | Nothing was committed | the repository is unchanged; certificates are generated per run and never written into it |

## How a claim may be reported

Three outcomes, not two. `held` means the evidence was gathered and says so. `failed` means it
was gathered and says otherwise. **`inconclusive`** means it could not be gathered — a command
that did not run, an inventory that errored, a refusal whose reason nothing recorded — and it
fails the run exactly as `failed` does.

The distinction exists because the second and third were once the same thing: an inventory that
failed was read as an empty inventory, so "nothing survives the run" was reported as held by a
daemon that had stopped answering.

## What a passing run does **not** establish

- Nothing about AWS. No image is pushed, no plan is applied, no ECS task runs. The connection
  semantics are the same ones the generator emits; the infrastructure is not.
- Nothing about scale, durability or failover. One container each, for one run.
- Nothing about the generated pipeline's identity boundaries, which are repository and account
  settings and are checked elsewhere or not at all.

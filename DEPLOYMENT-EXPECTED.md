# What this repository's generated deployment must specify

`EXPECTED.md` states what a **run** of this scenario must show, locally, with real containers.
This states what the **generated AWS deployment** for the same repository must say — the
specification of the artefact, not of an execution.

The distinction matters because the two are checked by different evidence and neither substitutes
for the other. A local Compose run says nothing about a task definition; a correct task definition
says nothing about whether the application works. Both, separately, or neither.

Every row is something an operator could confirm by reading the generated files beside the
application source and asking "does this deploy *that*?". Nothing here is satisfied by a file
existing, by a resource being declared, or by a name being mentioned somewhere in the plan.

**How much independence each row has, stated rather than implied.** `EXPECTED.md` was written
before the harness that checks it, and says so. This document was not: several rows were
confirmed against generated output while being written, so they guard against regression rather
than deriving the requirement from scratch. Calling the whole thing independent would be the
error it exists to catch, so the two kinds are marked:

- **†** — derived from a defect this repository actually shipped, recorded before this document
  and reproduced by an independent reviewer. These state a requirement the generator was measured
  failing, so they do not depend on reading the generator to be justified.
- unmarked — confirmed against the generated output while writing. Real properties, and a
  genuine guard against their loss, but not arrived at independently of what the generator
  already does.

The honest use of an unmarked row is "this must not silently change"; only a **†** row can be
offered as "this was required before anything satisfied it".

## The images

| # | Claim | How it is confirmed |
| --- | --- | --- |
| G1 | Each service is built from its own context and the recipe this repository selects | the publish matrix carries one entry per service, each naming that service's context and its selected `dockerfile` |
| G2† | The queue consumer deploys its **own** image, not the serving one | the deploy job resolves a digest from the worker's own ECR repository, separate from the serving repository |
| G3 | What is deployed is a digest, not a tag | the rollout resolves the pushed tag to an image digest and registers a task definition naming that digest |

`G2` was wrong once: a repository building `services/api` and `services/worker` separately
deployed the API's image to both services, and the consumer's own published image was never run.

## The serving path

| # | Claim | How it is confirmed |
| --- | --- | --- |
| G4† | The load balancer polls the route the application proves, not a conventional one | `health_check_path` is the path the serving workload's own health evidence establishes |
| G5† | Only a success response counts as healthy | `health_check_matcher` admits no 4xx code |
| G6 | The container port is the port the application listens on | `container_port` is the port the serving workload declares |

`G4` and `G5` were both wrong until recently: the generated target group polled `/`, which this
application does not implement, with a matcher that accepted `404` — while the rollout's own check
demanded a success from that same path. The one route that queries the database and pings the
cache was never called.

## The data stores

| # | Claim | How it is confirmed |
| --- | --- | --- |
| G7 | The database is bound under the names the application reads | the task environment binds the host, port and database name the application's own source declares |
| G8† | How to reach the endpoint is bound, not assumed | the task environment binds a verifying TLS mode and the path of the certificate authority |
| G9 | The cache is reached over TLS | the generated cache URL carries the `rediss://` scheme |

`G8` exists because RDS terminates TLS and PostgreSQL 15 and later reject a plaintext client,
while the drivers connect in the clear unless told otherwise. A task given a host, a port and a
credential and nothing else starts, connects to nothing, and fails on its first query.

## The credentials

| # | Claim | How it is confirmed |
| --- | --- | --- |
| G10 | The credential is injected, never composed | the user and password are secret references resolved at task start |
| G11 | No password reaches the module, its variables or its plan output | no generated file carries a literal credential value |

## The worker

| # | Claim | How it is confirmed |
| --- | --- | --- |
| G12 | The consumer runs as its own service, not as a second copy of the API | a separate ECS service and task definition with its own desired count |
| G13† | Each service writes to its own log stream | the serving service and the worker have different log groups |

`G13` is not housekeeping: one group for two services is two applications interleaved in one
stream, which nobody notices until they are reading it during an incident.

## The rollout

| # | Claim | How it is confirmed |
| --- | --- | --- |
| G14 | No placeholder image ever serves traffic | the service is created at its initial desired count and the rollout, not Terraform, decides what runs afterwards |
| G15 | A deployment that changed nothing is not reported as a release | the apply is skipped rather than failed when the plan holds no change, and the rollout still verifies what is running |

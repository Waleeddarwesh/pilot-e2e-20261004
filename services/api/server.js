'use strict'

/*
 * The reference API.
 *
 * It exists to be *run*, not to be scanned. Every route below does something a deployment can be
 * wrong about: the health route touches both data stores rather than returning a constant, the
 * enqueue route puts real work on the queue, and the result route reads what the worker wrote to
 * PostgreSQL. An HTTP 200 from this service means the database accepted a query, the cache
 * answered over TLS and the two are reachable from this task -- which is the set of facts a
 * generated deployment is supposed to establish and which `ok` alone establishes none of.
 *
 * The environment contract is the one Pilot's generator binds, deliberately: DB_HOST, DB_PORT,
 * DB_NAME and the credential as DB_USER/DB_PASSWORD secrets, and the cache as a single REDIS_URL
 * carrying its scheme. An application reading DATABASE_URL instead is a real and common shape, and
 * it is one the generator refuses with `unresolved-connection-binding` rather than composing a
 * URL that would put the password into Terraform state -- so the reference reads what is bound.
 */

const express = require('express')
const { Pool } = require('pg')
const IORedis = require('ioredis')
const { Queue } = require('bullmq')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')

/*
 * Every binding read directly, at the place it is used.
 *
 * Writing this with a `required('DB_HOST')` helper was the obvious thing and it is the wrong
 * thing: the scanner reads `process.env.NAME`, so a helper hides the contract, and the cache
 * transport check could not establish that the URL reaching ioredis is the generated one. Both
 * are the product behaving correctly -- it will not infer through an arbitrary call -- and the
 * reference is supposed to exercise the supported path, not to argue with it.
 *
 * The validation stayed; only the indirection went.
 */
const missing = [
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'REDIS_URL'
].filter((name) => !process.env[name])

if (missing.length > 0) {
  // Fail at start rather than on the first request: a task that cannot reach its data stores
  // should never report itself healthy, and a missing binding is a deployment defect.
  throw new Error(
    `${missing.join(', ')} not set. This service is started by the generated task definition.`
  )
}

/*
 * How this client reaches the database, decided here rather than assumed.
 *
 * An encrypted server does not make an unencrypted client encrypted. node-postgres connects
 * without TLS unless it is told to, and RDS terminates TLS with `rds.force_ssl=1` by default on
 * PostgreSQL 15 and later -- so a task handed a host, a port and a credential and nothing else
 * starts, connects to nothing, and fails on its first query. The generated task definition binds
 * `DB_SSL_MODE` and `DB_CA_BUNDLE` for exactly this, and the reference reads them.
 *
 * Verification is on and stays on. `require` encrypts without authenticating: it accepts any
 * certificate, which protects against a passive listener and not at all against something
 * answering in the database's place. `rejectUnauthorized: false` is how a reference fixture
 * teaches the wrong thing, so the only way to a plaintext connection here is `DB_SSL_MODE=disable`
 * -- which the smoke harness asks for once, deliberately, as a negative control.
 *
 * Written as one `ssl` option with a resolvable value rather than a spread of a helper: the
 * generated deployment's own check reads the option a driver reads, and an expression it cannot
 * follow is reported as unconfigured. The reference exercises the legible, supported shape.
 */
const ssl =
  process.env.DB_SSL_MODE === 'disable'
    ? false
    : {
        rejectUnauthorized: true,
        servername: process.env.DB_HOST,
        ca: readFileSync(process.env.DB_CA_BUNDLE, 'utf8')
      }

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl
})

/*
 * The cache endpoint as a URL, read straight from the environment.
 *
 * The generated value is `rediss://…`, and ioredis takes the scheme from the connection string it
 * is given positionally. Rewriting it, or passing `host:` instead, is what the transport checks
 * refuse -- so the reference does neither.
 */
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
const queue = new Queue('reference', { connection })

const app = express()
app.use(express.json())

/*
 * A thrown handler is a 500, not an exit.
 *
 * Express does not await an async handler, so a rejection inside one becomes an unhandled
 * rejection -- and Node exits on those. Measured here: one bad request to the replay route killed
 * the service outright, which is a far worse failure than the request that caused it. Wrapping is
 * the whole fix; express 5 does this itself, and this fixture pins 4.
 */
const route = (handler) => (request, response, next) =>
  Promise.resolve(handler(request, response)).catch(next)

/** Creates the table the worker writes to. Idempotent, so every start is safe. */
async function migrate() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS job_results (' +
      'id TEXT PRIMARY KEY, ' +
      'input INTEGER NOT NULL, ' +
      'value INTEGER NOT NULL, ' +
      'completed_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  )
}

/*
 * Health that means something.
 *
 * A route returning a constant proves the process is listening and nothing else: a task with no
 * database credential, or one that cannot reach the cache, answers it exactly as a working one
 * does. This asks both stores and reports which failed.
 */
app.get('/health', route(async (_request, response) => {
  const checks = { database: false, cache: false }

  /*
   * Bounded, because an unreachable store must make this *fail* rather than hang.
   *
   * Measured: with the cache stopped, `connection.ping()` never settled and the route never
   * answered. `maxRetriesPerRequest: null` is right for the queue -- BullMQ requires it, and a
   * job should wait for the cache to come back rather than be dropped -- but it means an
   * ordinary command queues indefinitely. A health endpoint that hangs is worse than one that
   * fails: the load balancer eventually times out and reports nothing about which store was the
   * problem, which is the one thing this route exists to say.
   */
  const within = (work, seconds) =>
    Promise.race([
      work,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${seconds}s`)), seconds * 1000)
      )
    ])

  try {
    await within(pool.query('SELECT 1'), 3)
    checks.database = true
  } catch (error) {
    response.status(503).json({ ok: false, checks, error: `database: ${String(error && error.message)}` })
    return
  }

  try {
    const pong = await within(connection.ping(), 3)
    checks.cache = pong === 'PONG'
  } catch (error) {
    response.status(503).json({ ok: false, checks, error: `cache: ${String(error && error.message)}` })
    return
  }

  const ok = checks.database && checks.cache
  response.status(ok ? 200 : 503).json({ ok, checks })
}))

/**
 * Puts real work on the queue and returns the id the result will arrive under.
 *
 * The identity is the application's, not the queue's. BullMQ's own sequence is numeric and it
 * refuses a numeric *custom* id -- "Custom Ids cannot be integers" -- so a job whose id came from
 * that sequence can never be re-submitted under its own identity. Measured: the replay route
 * threw, and because an async express handler that throws becomes an unhandled rejection, Node
 * exited and took the service with it.
 */
app.post('/jobs', route(async (request, response) => {
  const input = Number(request.body && request.body.input)
  if (!Number.isInteger(input)) {
    response.status(400).json({ error: 'input must be an integer' })
    return
  }
  const id = `job-${randomUUID()}`
  await queue.add('square', { input }, { jobId: id, removeOnComplete: true })
  response.status(202).json({ id, input })
}))

/*
 * Delivers the same job identity again.
 *
 * Queues deliver at least once, and the interesting question is what the *worker* does with a
 * second delivery -- not whether PostgreSQL has a primary key. This re-adds the job under its own
 * id so the worker processes it again, which is what makes the idempotent write worth having.
 */
app.post('/jobs/:id/replay', route(async (request, response) => {
  const { rows } = await pool.query('SELECT input FROM job_results WHERE id = $1', [
    request.params.id
  ])
  if (rows.length === 0) {
    response.status(404).json({ error: 'nothing to replay' })
    return
  }
  await queue.add(
    'square',
    { input: rows[0].input },
    { jobId: request.params.id, removeOnComplete: true }
  )
  response.status(202).json({ id: request.params.id, replayed: true })
}))

/** What the worker wrote, from PostgreSQL rather than from memory. */
app.get('/jobs/:id', route(async (request, response) => {
  const { rows } = await pool.query(
    'SELECT id, input, value, completed_at FROM job_results WHERE id = $1',
    [request.params.id]
  )
  if (rows.length === 0) {
    response.status(404).json({ error: 'no result yet' })
    return
  }
  response.json(rows[0])
}))

const port = Number(process.env.PORT || 3000)

migrate()
  .then(() => {
    app.listen(port, () => {
      console.log(`reference api listening on ${port}`)
    })
  })
  .catch((error) => {
    console.error('migration failed', error)
    process.exit(1)
  })

/*
 * Shut down when asked.
 *
 * ECS sends SIGTERM and then kills the task; a process that ignores it is a rollout that stalls
 * for the full timeout on every deploy.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    Promise.allSettled([pool.end(), queue.close(), connection.quit()]).then(() => process.exit(0))
  })
}

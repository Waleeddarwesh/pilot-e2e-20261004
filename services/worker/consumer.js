'use strict'

/*
 * The reference worker.
 *
 * It consumes the queue the API writes to and records the result in PostgreSQL, so "the worker
 * ran" is a row somebody can read rather than a line in a log. That distinction is the whole
 * reason this exists: a worker that starts, connects and then silently processes nothing looks
 * identical to a working one from the outside, and every check short of an observed result
 * accepts it.
 *
 * Same environment contract as the API, for the same reason: it is what the generated task
 * definition binds.
 */

const { Worker } = require('bullmq')
const IORedis = require('ioredis')
const { Pool } = require('pg')
const { readFileSync } = require('node:fs')

/*
 * Read directly, for the same reason as the API: a helper hides the contract from the scanner and
 * makes the cache transport unprovable. See the note there.
 */
const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'REDIS_URL'].filter(
  (name) => !process.env[name]
)

if (missing.length > 0) {
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

// The endpoint as a URL, scheme included. The generated value is `rediss://…`.
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })

const worker = new Worker(
  'reference',
  async (job) => {
    const input = Number(job.data.input)
    if (!Number.isInteger(input)) throw new Error(`job ${job.id} carries no integer input`)

    const value = input * input
    /*
     * Written under the job's own id, so a second delivery of the same job cannot produce a
     * second row. Queues deliver at least once; a worker that assumes exactly once writes
     * duplicates the first time a container is replaced mid-job.
     */
    await pool.query(
      'INSERT INTO job_results (id, input, value) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (id) DO UPDATE SET input = EXCLUDED.input, value = EXCLUDED.value',
      [String(job.id), input, value]
    )
    console.log(`job ${job.id}: ${input} -> ${value}`)
    return value
  },
  { connection, concurrency: 2 }
)

worker.on('failed', (job, error) => {
  console.error(`job ${job && job.id} failed:`, error && error.message)
})

worker.on('ready', () => {
  console.log('reference worker connected and waiting for jobs')
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    // Finish what is in flight before exiting, which is what `worker.close()` waits for.
    worker
      .close()
      .then(() => Promise.allSettled([pool.end(), connection.quit()]))
      .then(() => process.exit(0))
  })
}

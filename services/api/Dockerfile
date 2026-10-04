# The image this service actually runs from.
#
# `npm ci` rather than `npm install`, from the lockfile beside this file: a build that resolves
# versions at build time produces a different image every day and a deployment nobody can
# reproduce. `--omit=dev` because nothing here needs a test runner at runtime.
#
# The manifest is copied before the source so a change to the application does not reinstall the
# dependency tree, which is the difference between a ten-second rebuild and a two-minute one.
FROM node:22-alpine

WORKDIR /app

# The database authority the generated task is told to read.
#
# `DB_CA_BUNDLE=/etc/ssl/certs/rds-global-bundle.pem` names a path, and a path is not a file: the
# application reads it at startup, so an image without it produces a task that dies on its first
# query. AWS publishes one bundle covering every region, and it rotates — the image records which
# one it carries by the date it was built, and generation raises a prerequisite for any build that
# installs nothing here.
#
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
RUN chmod 0644 /etc/ssl/certs/rds-global-bundle.pem

COPY package.json package-lock.json ./
# The process starts with node, so npm is not needed once the dependencies are in; it is
# removed with the vulnerabilities an image scan finds in it.
RUN npm ci --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY server.js ./

EXPOSE 3000

# Declared here rather than left to be inferred. A health check that reaches the data stores is
# the one this service implements, and a deployment that cannot see it has no way to tell a task
# with no database credential from a working one.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# `node` directly, not `npm start`: npm forwards no signals, so SIGTERM would reach the package
# manager and the application would be killed rather than shut down.
CMD ["node", "server.js"]

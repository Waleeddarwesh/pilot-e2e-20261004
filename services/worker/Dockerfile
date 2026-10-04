# The worker's own image, built from its own context.
#
# One image per deployable service. Sharing a repository between the two makes them
# indistinguishable by tag, which is how a worker comes to run the API's image and report itself
# healthy while draining nothing.
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

COPY consumer.js ./

# No port and no HTTP health check: this service listens on nothing. Its liveness is whether it is
# consuming, which the reference observes as a row in PostgreSQL rather than as a probe.
CMD ["node", "consumer.js"]

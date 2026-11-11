# Self-hosted ReliefGrid: one container with a persistent SQLite database.
FROM node:22-alpine

WORKDIR /app
# NODE_ENV=production also activates CAP's production profile (SAP HANA, XSUAA), which is
# applied after selfhost; the two settings below keep the container on SQLite and basic auth.
ENV NODE_ENV=production \
    CDS_ENV=selfhost \
    CDS_REQUIRES_DB_KIND=sqlite \
    CDS_REQUIRES_AUTH_KIND=basic \
    PORT=4004

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY _i18n ./_i18n
COPY app ./app
# SEC-07: the apps' QUnit test pages never ship
RUN find app -path '*/webapp/test' -type d -prune -exec rm -rf {} +
COPY db ./db
COPY srv ./srv
COPY server.js ./
# Stage F: consistent, verified backups from inside the container (node scripts/backup-database.js)
COPY scripts ./scripts

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4004

CMD ["node", "node_modules/@sap/cds/bin/serve.js"]

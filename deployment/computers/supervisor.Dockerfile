# Source comes from the exact OpenBot revision in compose.computers.yml.
FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY --from=openbot supervisor/package.json supervisor/bun.lock ./
RUN bun install --frozen-lockfile
COPY --from=openbot supervisor/src ./src
COPY deployment/computers/LICENSE.openbot ./LICENSE.openbot
COPY deployment/computers/b2-archive-format.mjs deployment/computers/b2-archive-core.mjs deployment/computers/b2-archive-supervisor.mjs /app/src/
COPY deployment/computers/harden-supervisor.mjs /tmp/harden-supervisor.mjs
RUN bun /tmp/harden-supervisor.mjs /app/src/environment.ts /app/src/index.ts \
  && rm /tmp/harden-supervisor.mjs
# Fail the image build, not the first backup, if the patched source does not resolve
# or parse: bundling follows every import from the entrypoint and verifies the backup
# modules are really part of what runs.
RUN bun build src/index.ts --target=bun --packages external --outfile=/tmp/supervisor-check.js \
  && grep -q "/export" /tmp/supervisor-check.js \
  && grep -q "/import" /tmp/supervisor-check.js \
  && grep -q "maxRequestBodySize" /tmp/supervisor-check.js \
  && rm /tmp/supervisor-check.js
EXPOSE 4300
CMD ["bun", "src/index.ts"]

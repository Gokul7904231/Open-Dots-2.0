# Source comes from the exact OpenBot revision in compose.computers.yml.
FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY --from=openbot supervisor/package.json supervisor/bun.lock ./
RUN bun install --frozen-lockfile
COPY --from=openbot supervisor/src ./src
COPY deployment/computers/LICENSE.openbot ./LICENSE.openbot
COPY deployment/computers/b2-archive-format.mjs /app/src/b2-archive-format.mjs
COPY deployment/computers/b2-archive-supervisor.mjs /app/src/b2-archive-supervisor.mjs
COPY deployment/computers/harden-supervisor.mjs /tmp/harden-supervisor.mjs
RUN bun /tmp/harden-supervisor.mjs /app/src/environment.ts /app/src/index.ts && rm /tmp/harden-supervisor.mjs
EXPOSE 4300
CMD ["bun", "src/index.ts"]

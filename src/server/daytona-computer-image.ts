/**
 * Image used for the experimental Daytona provider.
 *
 * The OpenBot source and Playwright version are pinned to the same reviewed
 * revision as compose.computers.yml. This avoids a floating upstream branch.
 */
export const DAYTONA_COMPUTER_DOCKERFILE = `FROM node:24.18.1-bookworm-slim AS node-toolchain
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-toolchain

FROM ubuntu:24.04
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils git \
  && ln -s bun /usr/local/bin/bunx \
  && bunx --bun "playwright@1.62.1" install --with-deps chromium \
  && rm -rf /root/.cache /tmp/* /var/lib/apt/lists/*

RUN git init /opt/OpenBot \
  && cd /opt/OpenBot \
  && git remote add origin https://github.com/CopilotKit/OpenBot.git \
  && git fetch --depth 1 origin b6932d31a8d6e7896c15139dfc27a6c6911deb27 \
  && git checkout --detach FETCH_HEAD
WORKDIR /opt/OpenBot/agent-computer
RUN bun install --frozen-lockfile
RUN mkdir -p /workspace /profiles
ENV WORKSPACE_DIR=/workspace
ENV PROFILES_DIR=/profiles
ENV PORT=4100
EXPOSE 4100
CMD ["bun", "src/index.ts"]`;

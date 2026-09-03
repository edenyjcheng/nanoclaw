# NanoClaw v2 server image — for NAS deployment (WO-008 Output 1)
#
# NOT derived from container/Dockerfile. In v2.3.0 that file builds the *agent*
# container (Bun runtime, chromium, source mounted read-only at /app/src,
# WORKDIR /workspace/group, USER node). The server is a separate concern and
# needs none of it. See the WO status block for the full rationale.
#
# WORKDIR is /share/nanoclaw on purpose: NanoClaw derives agent-container bind
# mount sources from process.cwd(). Under Docker-out-of-Docker the daemon
# resolving those paths is the NAS host daemon, so cwd must equal the real NAS
# host path or every agent spawn mounts a nonexistent directory.

# ---- Builder ----------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /build

# better-sqlite3 is a native dep. Prebuilds usually cover linux/x64 node22, but
# keep the toolchain here so a prebuild miss fails loudly at build time rather
# than at first DB write on the NAS.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# husky's `prepare` script runs on install and needs a git repo; there isn't one
# in the build context.
ENV HUSKY=0

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# NOTE: no `pnpm prune --prod` here. WO-008 option A runs v2's own installer
# (`pnpm run setup:auto`) on the NAS, which needs setup/ and tsx — and tsx is a
# devDependency. Pruning would strip exactly what the install step requires.
# Costs image size; irrelevant on a 2.1 TB share.

# ---- Runtime ----------------------------------------------------------------
FROM node:22-slim

# tzdata is absent from upstream v2.3.0 (checked: no tzdata/TZ/DEBIAN_FRONTEND
# anywhere in container/Dockerfile at 5ab77545). Without it TZ is inert and
# scheduled tasks fire on UTC instead of ET.
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        tzdata ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI for Docker-out-of-Docker. src/container-runtime.ts sets
# CONTAINER_RUNTIME_BIN = 'docker' and the server shells out to it to spawn
# agent containers — without this binary every spawn fails.
# Pinned to match the NAS daemon (27.1.2-qnap8).
ARG DOCKER_CLI_VERSION=27.1.2
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && docker --version

# OneCLI CLI — v2's credential path. setup/auth.ts shells out to `onecli`
# (`onecli secrets list` / `secrets create`), and src/gateway-providers has
# onecli as the only registered provider, so this binary is required, not
# optional. It CANNOT live on the NAS host: QTS ships glibc 2.21 and the
# binary needs 2.32/2.34. It runs here instead — node:22-slim is glibc 2.36.
# Installs to /usr/local/bin/onecli directly when run as root (it falls back to
# ~/.local/bin for non-root, which is what happens on the NAS host).
# The gate is `command -v`, not `onecli version` — that subcommand contacts the
# server, which is unreachable during a build.
RUN curl -fsSL onecli.sh/cli/install -o /tmp/onecli-install.sh \
    && sh /tmp/onecli-install.sh \
    && rm -f /tmp/onecli-install.sh \
    && command -v onecli

ENV TZ=America/New_York
# NOT production: `pnpm run setup:auto` needs devDependencies (tsx) resolvable.
ENV NODE_ENV=development

WORKDIR /share/nanoclaw

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./package.json
# Option A — v2 installs itself via its own wizard rather than us hand-seeding
# the DB. These are what `setup:auto` reads at runtime.
COPY --from=builder /build/setup ./setup
COPY --from=builder /build/container ./container
COPY --from=builder /build/scripts ./scripts
COPY --from=builder /build/tsconfig.json ./tsconfig.json
COPY --from=builder /build/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /build/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /build/.npmrc ./.npmrc

CMD ["node", "dist/index.js"]

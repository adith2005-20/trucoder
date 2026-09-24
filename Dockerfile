# TruCoder app image — multi-stage.
# Build stage: server tsc + web vite build. Runtime: node:24-slim (glibc,
# so better-sqlite3 uses its prebuilt linux-arm64 binary — no compilation).
#
# The app container has NO docker socket. Grading goes over the internal
# compose network to the sandbox daemons (SANDBOX_URL / SANDBOX_NODE_URL).

FROM node:24-slim AS build
WORKDIR /src

# Toolchain insurance: better-sqlite3 13.x ships arm64 glibc prebuilds, but
# if any native dep ever lacks one, the build stage can compile it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json /src/server/
RUN cd /src/server && npm ci
COPY server/ /src/server/
RUN cd /src/server && npx tsc && npm prune --omit=dev

COPY web/package.json web/package-lock.json /src/web/
RUN cd /src/web && npm ci
COPY web/ /src/web/

# BUILD_COMMIT is consumed ONLY by the vite build (vite.config.ts bakes it
# into __BUILD_COMMIT__). Declaring it here — after the apt/npm-ci layers —
# keeps those layers cacheable across pushes: an ARG change invalidates
# everything after it, and under QEMU-emulated arm64 builds a re-run of apt
# + both npm ci cost minutes (publish-images used to take ~15 min every
# push; now only tsc + the vite build re-run).
ARG BUILD_COMMIT=dev
ENV BUILD_COMMIT=${BUILD_COMMIT}
RUN cd /src/web && npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /src/server/dist /app/server/dist
COPY --from=build /src/server/scripts /app/server/scripts
COPY --from=build /src/server/package.json /app/server/package.json
COPY --from=build /src/server/node_modules /app/server/node_modules
COPY --from=build /src/web/dist /app/web/dist

# Anything copied out of the build context carries its host mode. Files the
# tooling creates land as 600, which the runtime user (uid 1000) cannot read:
# Node 24.21+ then fails HARD on the entry-point package.json probe
# ("Cannot read package config /app/server/package.json: permission denied")
# and the container crash-loops. Normalise the runtime tree instead of
# trusting the context.
RUN chmod -R a+rX /app/server/dist /app/server/scripts \
    /app/server/package.json /app/web/dist

# uid 1000 == host adith uid 1000, so the courses/ and data/ bind mounts
# (also adith-owned) are writable without root.
USER node

EXPOSE 3001
CMD ["node", "server/dist/index.js"]

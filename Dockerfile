# syntax=docker/dockerfile:1
# CI/test image for generated interface contracts.
FROM dart:3.13.0@sha256:8b6175f6c6b89aaf31ffdace4a22d17715c07f1cf3a772dadb10c658f779e23d AS dart-sdk
FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS node-sdk
FROM rust:1.98.0-bookworm@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922
COPY --from=dart-sdk /usr/lib/dart /usr/lib/dart
COPY --from=node-sdk /usr/local/bin/node /usr/local/bin/node
COPY --from=node-sdk /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV HOME=/tmp \
    CARGO_HOME=/tmp/cargo \
    DART_SDK=/usr/lib/dart \
    PATH=/usr/lib/dart/bin:$PATH
WORKDIR /app
RUN install -d -o 65532 -g 65532 /tmp/cargo \
    && chown 65532:65532 /app
COPY --chown=65532:65532 package.json package-lock.json ./
USER 65532:65532
RUN npm ci --ignore-scripts
COPY --chown=65532:65532 . .
RUN npm test

# --- sops: decrypt at `docker run`, never at `docker build` ------------------
# The image carries only CIPHERTEXT (env/enc/<SOPS_ENV>.env.enc) and the sops
# binary. The age key arrives at run time (SOPS_AGE_KEY / SOPS_AGE_KEY_FILE);
# scripts/sops-entrypoint.sh decrypts into the process environment and execs
# the real command, so no plaintext ever lands in a layer or on disk.
# See env/README.md.
ARG SOPS_ENV=local
COPY --chmod=0755 --from=ghcr.io/getsops/sops:v3.10.2-alpine /usr/local/bin/sops /usr/local/bin/sops
COPY --chmod=0755 scripts/sops-entrypoint.sh /usr/local/bin/sops-entrypoint.sh
COPY --chmod=0644 env/enc/${SOPS_ENV}.env.enc /app/secrets/app.env
ENV SOPS_SECRETS_FILE=/app/secrets/app.env

ENTRYPOINT ["/usr/local/bin/sops-entrypoint.sh"]
CMD ["npm", "test"]

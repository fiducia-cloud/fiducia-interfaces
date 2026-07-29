# syntax=docker/dockerfile:1
# CI/test image for generated interface contracts.
FROM dart:3.12.2@sha256:13140e26d84f4fda57cea31942222112aeb2eec10e5e6874c1c0f70beed189ab AS dart-sdk
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS node-sdk
FROM rust:1.97.1-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa
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
CMD ["npm", "test"]

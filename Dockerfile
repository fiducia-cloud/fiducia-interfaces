# syntax=docker/dockerfile:1
# CI/test image for generated interface contracts.
FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm
ENV HOME=/tmp \
    CARGO_HOME=/tmp/cargo
WORKDIR /app
RUN install -d -o 65532 -g 65532 /tmp/cargo \
    && chown 65532:65532 /app
COPY --chown=65532:65532 package.json package-lock.json ./
USER 65532:65532
RUN npm ci --ignore-scripts
COPY --chown=65532:65532 . .
RUN npm test
CMD ["npm", "test"]

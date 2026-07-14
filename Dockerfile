# syntax=docker/dockerfile:1
# CI/test image for generated interface contracts.
FROM rust:1.97.0-bookworm@sha256:7d0723df719e7f213b69dc7c8c595985c3f4b060cfbee4f7bc0e347a86fe3b6a
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

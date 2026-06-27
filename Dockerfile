# syntax=docker/dockerfile:1
# CI/test image for generated interface contracts.
FROM rust:1-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && npm install -g typescript
WORKDIR /app
COPY . .
RUN npm test
CMD ["npm", "test"]

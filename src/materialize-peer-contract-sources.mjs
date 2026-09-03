#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  gitBlobSha,
  validateManifestRules,
  validateManifestWithJsonSchema,
} from "./check-peer-contract-sources.mjs";

export class MaterializeError extends Error {
  constructor(message) {
    super(message);
    this.name = "MaterializeError";
  }
}

function invariant(condition, message) {
  if (!condition) {
    throw new MaterializeError(message);
  }
}

function githubContentsUrl(source) {
  const encodedPath = source.path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${source.repository}/contents/${encodedPath}`);
  url.searchParams.set("ref", source.commit);
  return url;
}

function authorityFilename(kind) {
  switch (kind) {
    case "typespec":
      return "commercial-intake.authority.tsp";
    case "json-schema":
      return "commercial-intake.authority.schema.json";
    default:
      throw new MaterializeError(`unsupported authority kind: ${kind}`);
  }
}

async function fetchAuthorityBytes(source, options) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fiducia-peer-contract-materializer/1",
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const response = await options.fetchImpl(githubContentsUrl(source), { headers });
  invariant(
    response.ok,
    `GitHub returned ${response.status} for ${source.repository}@${source.commit}:${source.path}`,
  );
  const payload = await response.json();
  invariant(payload.type === "file", `pinned resource is not a file: ${source.repository}:${source.path}`);
  invariant(payload.encoding === "base64", `unsupported GitHub encoding for ${source.repository}:${source.path}`);
  invariant(payload.sha === source.gitBlobSha, `GitHub API blob mismatch for ${source.repository}:${source.path}`);
  const bytes = Buffer.from(String(payload.content).replace(/\s+/gu, ""), "base64");
  invariant(
    gitBlobSha(bytes) === source.gitBlobSha,
    `decoded Git blob mismatch for ${source.repository}:${source.path}`,
  );
  const text = bytes.toString("utf8");
  for (const marker of source.expectedMarkers) {
    invariant(text.includes(marker), `${source.kind} authority is missing expected marker ${JSON.stringify(marker)}`);
  }
  if (source.kind === "json-schema") {
    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw new MaterializeError(`JSON Schema authority is invalid JSON: ${error.message}`);
    }
    invariant(
      document.$schema === "https://json-schema.org/draft/2020-12/schema",
      "JSON Schema authority must use Draft 2020-12",
    );
  }
  return bytes;
}

export async function materializeAuthorities(options = {}) {
  const root = path.resolve(options.root ?? fileURLToPath(new URL("..", import.meta.url)));
  const outputDirectory = path.resolve(options.outputDirectory ?? "");
  invariant(options.outputDirectory, "outputDirectory is required");
  const manifestPath = path.join(root, "provenance/commercial-intake.peer-sources.json");
  const schemaPath = path.join(root, "provenance/peer-contract-sources.schema.json");
  const [manifest, schema] = await Promise.all([
    readFile(manifestPath, "utf8").then(JSON.parse),
    readFile(schemaPath, "utf8").then(JSON.parse),
  ]);
  await validateManifestWithJsonSchema(manifest, schema);
  validateManifestRules(manifest);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  invariant(typeof fetchImpl === "function", "a fetch implementation is required");
  const files = [];
  for (const source of [...manifest.authorities].sort((left, right) => left.kind.localeCompare(right.kind))) {
    const filename = authorityFilename(source.kind);
    const bytes = await fetchAuthorityBytes(source, {
      fetchImpl,
      token: options.token,
    });
    await writeFile(path.join(outputDirectory, filename), bytes, { mode: 0o600 });
    files.push({
      kind: source.kind,
      filename,
      repository: source.repository,
      commit: source.commit,
      path: source.path,
      gitBlobSha: source.gitBlobSha,
    });
  }
  return {
    format: "fiducia.materialized-peer-authorities.v1",
    domain: manifest.domain,
    files,
  };
}

function parseArguments(argv) {
  let outputDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--output-dir") {
      outputDirectory = argv[++index];
      invariant(outputDirectory, "--output-dir requires a path");
    } else {
      throw new MaterializeError(`unexpected argument: ${token}`);
    }
  }
  invariant(outputDirectory, "--output-dir is required");
  return { outputDirectory };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const receipt = await materializeAuthorities({
    ...options,
    token: process.env.GITHUB_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

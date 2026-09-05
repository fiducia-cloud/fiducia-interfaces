#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const AUTHORITY_KINDS = new Set(["typespec", "json-schema"]);

export class PeerSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "PeerSourceError";
  }
}

function invariant(condition, message) {
  if (!condition) {
    throw new PeerSourceError(message);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeForCanonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeForCanonicalJson);
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeForCanonicalJson(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function gitBlobSha(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = Buffer.from(`blob ${buffer.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(buffer).digest("hex");
}

function assertSafeRelativePath(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  invariant(!path.isAbsolute(value), `${label} must be repository-relative`);
  invariant(!value.includes("\\"), `${label} must use forward slashes`);
  invariant(!value.split("/").includes(".."), `${label} may not contain parent traversal`);
}

function validateSourceReference(source, label) {
  invariant(isObject(source), `${label} must be an object`);
  invariant(REPOSITORY_PATTERN.test(source.repository), `${label}.repository is invalid`);
  invariant(SHA1_PATTERN.test(source.commit), `${label}.commit must be a full lowercase Git SHA`);
  invariant(SHA1_PATTERN.test(source.gitBlobSha), `${label}.gitBlobSha must be a full lowercase Git blob SHA`);
  assertSafeRelativePath(source.path, `${label}.path`);
  invariant(Array.isArray(source.expectedMarkers) && source.expectedMarkers.length > 0, `${label}.expectedMarkers must be non-empty`);
  invariant(
    source.expectedMarkers.every((marker) => typeof marker === "string" && marker.length > 0),
    `${label}.expectedMarkers must contain non-empty strings`,
  );
  invariant(
    new Set(source.expectedMarkers).size === source.expectedMarkers.length,
    `${label}.expectedMarkers must not contain duplicates`,
  );
}

function sourceFingerprintReference(source) {
  return {
    repository: source.repository,
    commit: source.commit,
    path: source.path,
    gitBlobSha: source.gitBlobSha,
  };
}

export function discrepancyFingerprint(manifest, discrepancy) {
  const authority = manifest.authorities.find(
    (candidate) => candidate.kind === discrepancy.sourceAuthority,
  );
  const publication = manifest.publicationSnapshots.find(
    (candidate) => candidate.id === discrepancy.publicationSnapshotId,
  );
  invariant(authority, `discrepancy ${discrepancy.id} references missing authority ${discrepancy.sourceAuthority}`);
  invariant(
    publication,
    `discrepancy ${discrepancy.id} references missing publication ${discrepancy.publicationSnapshotId}`,
  );
  const payload = {
    format: "fiducia.peer-source-discrepancy.v1",
    domain: manifest.domain,
    source: sourceFingerprintReference(authority),
    publication: sourceFingerprintReference(publication),
  };
  return sha256(Buffer.from(canonicalJson(payload), "utf8"));
}

export function validateManifestRules(manifest) {
  invariant(isObject(manifest), "peer-source manifest must be an object");
  invariant(manifest.format === "fiducia.peer-contract-sources.v1", "unexpected peer-source manifest format");
  invariant(typeof manifest.domain === "string" && manifest.domain.length > 0, "manifest domain is required");
  invariant(
    manifest.status === "PASS" || manifest.status === "STOPPED_FOR_EVALUATION",
    "manifest status must be PASS or STOPPED_FOR_EVALUATION",
  );
  invariant(isObject(manifest.policy), "manifest policy is required");
  invariant(manifest.policy.independentAuthorities === true, "TypeSpec and JSON Schema must remain independent authorities");
  invariant(manifest.policy.allowGeneratedAuthority === false, "generated artifacts may not become an authority");
  invariant(manifest.policy.failClosed === true, "peer-source discrepancies must fail closed");
  invariant(manifest.policy.productionMutation === false, "peer-source audit may not mutate production");

  invariant(Array.isArray(manifest.authorities), "manifest authorities must be an array");
  invariant(manifest.authorities.length === 2, "manifest must pin exactly two peer authorities");
  const authorityKinds = manifest.authorities.map((authority) => authority.kind);
  invariant(new Set(authorityKinds).size === authorityKinds.length, "authority kinds must be unique");
  invariant(
    AUTHORITY_KINDS.size === authorityKinds.length && authorityKinds.every((kind) => AUTHORITY_KINDS.has(kind)),
    "manifest must contain exactly TypeSpec and JSON Schema authorities",
  );
  for (const authority of manifest.authorities) {
    validateSourceReference(authority, `authority ${authority.kind}`);
    invariant(
      authority.authorship === "independent-human-authored",
      `authority ${authority.kind} must be independently human-authored`,
    );
    if (authority.kind === "typespec") {
      invariant(
        authority.scope === "http-operations-and-transport",
        "TypeSpec authority scope must be http-operations-and-transport",
      );
    } else {
      invariant(
        authority.scope === "payload-validation-and-interfaces",
        "JSON Schema authority scope must be payload-validation-and-interfaces",
      );
    }
  }

  invariant(
    Array.isArray(manifest.publicationSnapshots) && manifest.publicationSnapshots.length > 0,
    "manifest must record at least one publication snapshot",
  );
  const publicationIds = manifest.publicationSnapshots.map((publication) => publication.id);
  invariant(new Set(publicationIds).size === publicationIds.length, "publication snapshot IDs must be unique");
  for (const publication of manifest.publicationSnapshots) {
    validateSourceReference(publication, `publication ${publication.id}`);
    invariant(
      AUTHORITY_KINDS.has(publication.sourceAuthority),
      `publication ${publication.id} references an unsupported authority`,
    );
    invariant(
      publication.relationship === "exact-copy" || publication.relationship === "content-divergent",
      `publication ${publication.id} has an invalid relationship`,
    );
  }

  invariant(Array.isArray(manifest.discrepancies), "manifest discrepancies must be an array");
  const discrepancyIds = manifest.discrepancies.map((discrepancy) => discrepancy.id);
  invariant(new Set(discrepancyIds).size === discrepancyIds.length, "discrepancy IDs must be unique");

  for (const discrepancy of manifest.discrepancies) {
    invariant(isObject(discrepancy), "every discrepancy must be an object");
    invariant(discrepancy.status === "open" || discrepancy.status === "resolved", `${discrepancy.id} has invalid status`);
    invariant(SHA256_PATTERN.test(discrepancy.fingerprint), `${discrepancy.id} has invalid fingerprint syntax`);
    invariant(
      discrepancy.fingerprint === discrepancyFingerprint(manifest, discrepancy),
      `${discrepancy.id} fingerprint does not match its pinned source and publication`,
    );
    invariant(
      Array.isArray(discrepancy.resolutionCriteria) && discrepancy.resolutionCriteria.length > 0,
      `${discrepancy.id} must define resolution criteria`,
    );
  }

  for (const publication of manifest.publicationSnapshots) {
    const authority = manifest.authorities.find((candidate) => candidate.kind === publication.sourceAuthority);
    invariant(authority, `publication ${publication.id} references a missing authority`);
    const differs = authority.gitBlobSha !== publication.gitBlobSha;
    invariant(
      publication.relationship === (differs ? "content-divergent" : "exact-copy"),
      `publication ${publication.id} relationship does not match the pinned blob identities`,
    );
    const matchingOpenDiscrepancy = manifest.discrepancies.some(
      (discrepancy) =>
        discrepancy.status === "open" &&
        discrepancy.sourceAuthority === publication.sourceAuthority &&
        discrepancy.publicationSnapshotId === publication.id,
    );
    invariant(
      !differs || matchingOpenDiscrepancy,
      `publication ${publication.id} differs from its authority without an open discrepancy`,
    );
  }

  const hasOpenDiscrepancy = manifest.discrepancies.some((discrepancy) => discrepancy.status === "open");
  invariant(
    manifest.status === (hasOpenDiscrepancy ? "STOPPED_FOR_EVALUATION" : "PASS"),
    "manifest status does not match its discrepancy state",
  );
  if (manifest.status === "STOPPED_FOR_EVALUATION") {
    invariant(
      Array.isArray(manifest.blockedPromotions) && manifest.blockedPromotions.length > 0,
      "stopped manifests must enumerate blocked promotions",
    );
  }
  invariant(
    Array.isArray(manifest.nextRequiredEvidence) && manifest.nextRequiredEvidence.length > 0,
    "manifest must enumerate next required evidence",
  );
  return manifest;
}

export async function validateManifestWithJsonSchema(manifest, schema) {
  let Ajv2020;
  let addFormats;
  try {
    ({ default: Ajv2020 } = await import("ajv/dist/2020.js"));
    ({ default: addFormats } = await import("ajv-formats"));
  } catch (error) {
    throw new PeerSourceError(`JSON Schema validator dependencies are unavailable: ${error.message}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    const detail = (validate.errors ?? [])
      .map((entry) => `${entry.instancePath || "/"} ${entry.message}`)
      .join("; ");
    throw new PeerSourceError(`peer-source manifest failed JSON Schema validation: ${detail}`);
  }
  return manifest;
}

function githubContentsUrl(source) {
  const encodedPath = source.path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${source.repository}/contents/${encodedPath}`);
  url.searchParams.set("ref", source.commit);
  return url;
}

function verifyExpectedMarkers(source, bytes, label) {
  const content = bytes.toString("utf8");
  for (const marker of source.expectedMarkers) {
    invariant(content.includes(marker), `${label} is missing expected marker ${JSON.stringify(marker)}`);
  }
  return content;
}

function validateJsonSchemaDocument(content, label) {
  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new PeerSourceError(`${label} is not valid JSON: ${error.message}`);
  }
  invariant(
    document.$schema === "https://json-schema.org/draft/2020-12/schema",
    `${label} must use JSON Schema Draft 2020-12`,
  );
  invariant(isObject(document.$defs) && Object.keys(document.$defs).length > 0, `${label} must contain non-empty $defs`);
  return document;
}

function verifyPinnedBytes(source, bytes, label, kind) {
  const actualBlob = gitBlobSha(bytes);
  invariant(actualBlob === source.gitBlobSha, `${label} Git blob mismatch: expected ${source.gitBlobSha}, got ${actualBlob}`);
  const content = verifyExpectedMarkers(source, bytes, label);
  if (kind === "json-schema") {
    validateJsonSchemaDocument(content, label);
  }
  return {
    repository: source.repository,
    commit: source.commit,
    path: source.path,
    gitBlobSha: actualBlob,
    sha256: sha256(bytes),
  };
}

export async function fetchPinnedSource(source, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  invariant(typeof fetchImpl === "function", "a fetch implementation is required for remote verification");
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fiducia-peer-contract-audit/1",
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const response = await fetchImpl(githubContentsUrl(source), { headers });
  invariant(response.ok, `GitHub returned ${response.status} for ${source.repository}@${source.commit}:${source.path}`);
  const payload = await response.json();
  invariant(payload.type === "file", `pinned GitHub resource is not a file: ${source.repository}:${source.path}`);
  invariant(payload.encoding === "base64", `unsupported GitHub content encoding for ${source.repository}:${source.path}`);
  invariant(payload.sha === source.gitBlobSha, `GitHub API blob mismatch for ${source.repository}:${source.path}`);
  const bytes = Buffer.from(String(payload.content).replace(/\s+/gu, ""), "base64");
  const kind = source.kind ?? source.sourceAuthority;
  return verifyPinnedBytes(source, bytes, `remote ${source.repository}:${source.path}`, kind);
}

function resolveWithinRoot(root, relativePath) {
  assertSafeRelativePath(relativePath, "local publication path");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  invariant(
    resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`),
    `local publication path escapes repository root: ${relativePath}`,
  );
  return resolved;
}

export async function verifyLocalPublication(root, publication) {
  const bytes = await readFile(resolveWithinRoot(root, publication.path));
  return verifyPinnedBytes(
    publication,
    bytes,
    `local publication ${publication.path}`,
    publication.sourceAuthority,
  );
}

export async function auditPeerSources(options = {}) {
  const root = path.resolve(options.root ?? fileURLToPath(new URL("..", import.meta.url)));
  const localRepository = options.localRepository ?? "fiducia-cloud/fiducia-interfaces";
  const manifestPath = resolveWithinRoot(
    root,
    options.manifestPath ?? "provenance/commercial-intake.peer-sources.json",
  );
  const schemaPath = resolveWithinRoot(
    root,
    options.schemaPath ?? "provenance/peer-contract-sources.schema.json",
  );
  const [manifest, schema] = await Promise.all([
    readFile(manifestPath, "utf8").then(JSON.parse),
    readFile(schemaPath, "utf8").then(JSON.parse),
  ]);

  await validateManifestWithJsonSchema(manifest, schema);
  validateManifestRules(manifest);

  const localPublications = [];
  for (const publication of manifest.publicationSnapshots) {
    if (publication.repository === localRepository) {
      localPublications.push(await verifyLocalPublication(root, publication));
    }
  }

  const remotePins = [];
  if (options.remote === true) {
    for (const source of [...manifest.authorities, ...manifest.publicationSnapshots]) {
      remotePins.push(
        await fetchPinnedSource(source, {
          fetchImpl: options.fetchImpl,
          token: options.token,
        }),
      );
    }
  }

  return {
    format: "ores.schema-audit-receipt/v1",
    domain: manifest.domain,
    status: manifest.status,
    checks: {
      manifestJsonSchema: "PASS",
      manifestRules: "PASS",
      localPublicationSnapshots: localPublications.length > 0 ? "PASS" : "NOT_APPLICABLE",
      remotePinnedSources: options.remote === true ? "PASS" : "SKIPPED",
    },
    authorities: manifest.authorities.map((authority) => sourceFingerprintReference(authority)),
    publicationSnapshots: manifest.publicationSnapshots.map((publication) => ({
      id: publication.id,
      sourceAuthority: publication.sourceAuthority,
      relationship: publication.relationship,
      ...sourceFingerprintReference(publication),
    })),
    discrepancies: manifest.discrepancies.map((discrepancy) => ({
      id: discrepancy.id,
      status: discrepancy.status,
      classification: discrepancy.classification,
      fingerprint: discrepancy.fingerprint,
    })),
    blockedPromotions: manifest.blockedPromotions,
    observed: {
      localPublications,
      remotePins,
    },
  };
}

function parseArguments(argv) {
  const options = {
    remote: false,
    localRepository: "fiducia-cloud/fiducia-interfaces",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--remote":
        options.remote = true;
        break;
      case "--offline":
        options.remote = false;
        break;
      case "--manifest":
        options.manifestPath = argv[++index];
        invariant(options.manifestPath, "--manifest requires a path");
        break;
      case "--schema":
        options.schemaPath = argv[++index];
        invariant(options.schemaPath, "--schema requires a path");
        break;
      case "--output":
        options.outputPath = argv[++index];
        invariant(options.outputPath, "--output requires a path");
        break;
      default:
        throw new PeerSourceError(`unexpected argument: ${token}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const receipt = await auditPeerSources({
    ...options,
    token: process.env.GITHUB_TOKEN,
  });
  const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
  if (options.outputPath) {
    await writeFile(path.resolve(options.outputPath), rendered, "utf8");
  }
  process.stdout.write(rendered);
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

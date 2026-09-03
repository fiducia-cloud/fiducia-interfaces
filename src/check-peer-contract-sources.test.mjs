import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PeerSourceError,
  canonicalJson,
  discrepancyFingerprint,
  fetchPinnedSource,
  gitBlobSha,
  validateManifestRules,
  validateManifestWithJsonSchema,
} from "./check-peer-contract-sources.mjs";

const manifestUrl = new URL("../provenance/commercial-intake.peer-sources.json", import.meta.url);
const schemaUrl = new URL("../provenance/peer-contract-sources.schema.json", import.meta.url);

function clone(value) {
  return structuredClone(value);
}

function minimalManifest() {
  const manifest = {
    $schema: "./peer-contract-sources.schema.json",
    format: "fiducia.peer-contract-sources.v1",
    domain: "commercial-intake",
    status: "STOPPED_FOR_EVALUATION",
    policy: {
      independentAuthorities: true,
      allowGeneratedAuthority: false,
      failClosed: true,
      productionMutation: false,
    },
    authorities: [
      {
        kind: "typespec",
        authorship: "independent-human-authored",
        scope: "http-operations-and-transport",
        repository: "example/contracts",
        commit: "1".repeat(40),
        path: "contracts/main.tsp",
        gitBlobSha: "2".repeat(40),
        expectedMarkers: ["@service"],
      },
      {
        kind: "json-schema",
        authorship: "independent-human-authored",
        scope: "payload-validation-and-interfaces",
        repository: "example/contracts",
        commit: "1".repeat(40),
        path: "contracts/main.schema.json",
        gitBlobSha: "3".repeat(40),
        expectedMarkers: ["$schema"],
      },
    ],
    publicationSnapshots: [
      {
        id: "example-publication",
        sourceAuthority: "json-schema",
        relationship: "content-divergent",
        repository: "example/interfaces",
        commit: "4".repeat(40),
        path: "schema/main.schema.json",
        gitBlobSha: "5".repeat(40),
        expectedMarkers: ["$schema"],
      },
    ],
    discrepancies: [
      {
        id: "example-publication-divergence",
        classification: "unreconciled-peer-publication",
        status: "open",
        sourceAuthority: "json-schema",
        publicationSnapshotId: "example-publication",
        fingerprint: "",
        summary: "The publication differs from the pinned authority.",
        evidence: ["The immutable Git blob identities differ."],
        resolutionCriteria: ["Produce reviewed semantic parity evidence."],
      },
    ],
    blockedPromotions: ["client-certification"],
    nextRequiredEvidence: ["A deterministic parity receipt."],
  };
  manifest.discrepancies[0].fingerprint = discrepancyFingerprint(
    manifest,
    manifest.discrepancies[0],
  );
  return manifest;
}

test("canonical JSON and Git blob hashing are deterministic", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.equal(gitBlobSha(Buffer.from("test\n", "utf8")), "9daeafb9864cf43055ae93beb0afd6c7d144bfa4");
});

test("the checked-in manifest truthfully records an open fail-closed discrepancy", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.doesNotThrow(() => validateManifestRules(manifest));
  assert.equal(manifest.status, "STOPPED_FOR_EVALUATION");
  assert.equal(
    manifest.discrepancies[0].fingerprint,
    discrepancyFingerprint(manifest, manifest.discrepancies[0]),
  );
});

test("manifest rules reject silent promotion while pinned blobs differ", () => {
  const manifest = minimalManifest();
  manifest.status = "PASS";
  assert.throws(() => validateManifestRules(manifest), /status does not match/);

  const missingDiscrepancy = minimalManifest();
  missingDiscrepancy.discrepancies = [];
  assert.throws(() => validateManifestRules(missingDiscrepancy), /without an open discrepancy/);
});

test("manifest rules reject stale discrepancy fingerprints", () => {
  const manifest = minimalManifest();
  manifest.discrepancies[0].fingerprint = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateManifestRules(manifest), /fingerprint does not match/);
});

test("remote verification checks immutable blob identity, markers, and JSON Schema draft", async () => {
  const bytes = Buffer.from(
    `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { sample: { type: "string" } },
    })}\n`,
    "utf8",
  );
  const source = {
    kind: "json-schema",
    repository: "example/contracts",
    commit: "a".repeat(40),
    path: "contracts/main.schema.json",
    gitBlobSha: gitBlobSha(bytes),
    expectedMarkers: ["draft/2020-12", '"sample"'],
  };
  const fetchImpl = async (_url, request) => {
    assert.equal(request.headers.Authorization, "Bearer test-token");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "file",
          encoding: "base64",
          sha: source.gitBlobSha,
          content: bytes.toString("base64"),
        };
      },
    };
  };

  const result = await fetchPinnedSource(source, { fetchImpl, token: "test-token" });
  assert.equal(result.gitBlobSha, source.gitBlobSha);
  assert.match(result.sha256, /^sha256:[0-9a-f]{64}$/u);
});

test("remote verification rejects API/blob disagreement and missing markers", async () => {
  const bytes = Buffer.from("@service namespace Example;\n", "utf8");
  const source = {
    kind: "typespec",
    repository: "example/contracts",
    commit: "a".repeat(40),
    path: "contracts/main.tsp",
    gitBlobSha: gitBlobSha(bytes),
    expectedMarkers: ["@service", "@route"],
  };
  const wrongApiSha = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        type: "file",
        encoding: "base64",
        sha: "f".repeat(40),
        content: bytes.toString("base64"),
      };
    },
  });
  await assert.rejects(() => fetchPinnedSource(source, { fetchImpl: wrongApiSha }), /GitHub API blob mismatch/);

  const missingMarker = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        type: "file",
        encoding: "base64",
        sha: source.gitBlobSha,
        content: bytes.toString("base64"),
      };
    },
  });
  await assert.rejects(() => fetchPinnedSource(source, { fetchImpl: missingMarker }), /missing expected marker/);
});

let jsonSchemaDependenciesAvailable = true;
try {
  await import("ajv/dist/2020.js");
  await import("ajv-formats");
} catch {
  jsonSchemaDependenciesAvailable = false;
}

test(
  "the manifest validates against the checked-in Draft 2020-12 meta-contract",
  { skip: !jsonSchemaDependenciesAvailable },
  async () => {
    const [manifest, schema] = await Promise.all([
      readFile(manifestUrl, "utf8").then(JSON.parse),
      readFile(schemaUrl, "utf8").then(JSON.parse),
    ]);
    await assert.doesNotReject(() => validateManifestWithJsonSchema(manifest, schema));

    const invalid = clone(manifest);
    invalid.policy.failClosed = false;
    await assert.rejects(
      () => validateManifestWithJsonSchema(invalid, schema),
      PeerSourceError,
    );
  },
);

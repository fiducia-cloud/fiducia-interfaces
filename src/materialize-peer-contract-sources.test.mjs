import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discrepancyFingerprint, gitBlobSha } from "./check-peer-contract-sources.mjs";
import {
  MaterializeError,
  materializeAuthorities,
} from "./materialize-peer-contract-sources.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);

function responseFor(sourceByPath) {
  return async (url, request) => {
    assert.equal(request.headers.Authorization, "Bearer ephemeral-test-token");
    const source = sourceByPath.get(url.pathname);
    assert.ok(source, `unexpected GitHub path: ${url.pathname}`);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "file",
          encoding: "base64",
          sha: gitBlobSha(source),
          content: source.toString("base64"),
        };
      },
    };
  };
}

test("materializer validates immutable authorities and writes fixed private filenames", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "provenance/commercial-intake.peer-sources.json"), "utf8"),
  );
  const sourceByPath = new Map();
  for (const source of manifest.authorities) {
    const bytes = source.kind === "typespec"
      ? Buffer.from(`${source.expectedMarkers.join("\n")}\n`, "utf8")
      : Buffer.from(`${JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "https://fiducia.invalid/schemas/commercial-intake.schema.json",
          $defs: {
            preInterest: { type: "object" },
            application: { type: "object" },
            quote: { type: "object" },
            contractAcceptance: { type: "object" },
          },
        }, null, 2)}\n`, "utf8");
    source.gitBlobSha = gitBlobSha(bytes);
    sourceByPath.set(`/repos/${source.repository}/contents/${source.path}`, bytes);
  }
  for (const discrepancy of manifest.discrepancies) {
    discrepancy.fingerprint = discrepancyFingerprint(manifest, discrepancy);
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "fiducia-peer-materializer-"));
  try {
    const fixtureRoot = path.join(temporaryRoot, "repo");
    const outputDirectory = path.join(temporaryRoot, "output");
    await Promise.all([
      mkdir(path.join(fixtureRoot, "provenance"), { recursive: true }),
      mkdir(path.join(fixtureRoot, "schema"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(fixtureRoot, "provenance/commercial-intake.peer-sources.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
      readFile(path.join(root, "provenance/peer-contract-sources.schema.json")).then((bytes) =>
        writeFile(path.join(fixtureRoot, "provenance/peer-contract-sources.schema.json"), bytes),
      ),
      readFile(path.join(root, "schema/commercial_intake.schema.json")).then((bytes) =>
        writeFile(path.join(fixtureRoot, "schema/commercial_intake.schema.json"), bytes),
      ),
    ]);

    const receipt = await materializeAuthorities({
      root: fixtureRoot,
      outputDirectory,
      token: "ephemeral-test-token",
      fetchImpl: responseFor(sourceByPath),
    });
    assert.deepEqual(
      receipt.files.map((entry) => entry.filename),
      [
        "commercial-intake.authority.schema.json",
        "commercial-intake.authority.tsp",
      ],
    );
    assert.match(
      await readFile(path.join(outputDirectory, "commercial-intake.authority.tsp"), "utf8"),
      /@service/u,
    );
    assert.match(
      await readFile(path.join(outputDirectory, "commercial-intake.authority.schema.json"), "utf8"),
      /draft\/2020-12/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("materializer requires an explicit output directory", async () => {
  await assert.rejects(
    () => materializeAuthorities({ root }),
    MaterializeError,
  );
});

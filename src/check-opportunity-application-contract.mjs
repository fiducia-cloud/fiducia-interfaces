import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateOpportunityApplicationPacket } from "./opportunity-application-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const contractRoot = path.join(root, "contracts", "opportunity-application");
const expectedIds = [
  "ConsequentialCommitments",
  "ExplicitApproval",
  "IntakeMode",
  "OpportunityApplicationPacket",
  "OpportunityKind",
  "PacketState",
  "PublicCompanyReferences",
];
const expectedDeclarations = expectedIds.map((id) => `FiduciaOpportunityContract.${id}`);
const validatorCommit = "2281843126ab644607b11cf8281d84f382d68dfc";

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function jsonFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function credentialScan(value, location = "contract") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const patterns = [
    /ghp_[A-Za-z0-9]{20,}/u,
    /github_pat_[A-Za-z0-9_]{20,}/u,
    /lin_api_[A-Za-z0-9_-]{20,}/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ];
  for (const pattern of patterns) assert.equal(pattern.test(text), false, `${location} contains credential-shaped material`);
}

export async function checkOpportunityApplicationContract() {
  const [typespec, authored, consumer] = await Promise.all([
    readFile(path.join(contractRoot, "main.tsp"), "utf8"),
    json(path.join(contractRoot, "authored.schema.json")),
    json(path.join(root, "contract-admission", "opportunity-application-consumer.json")),
  ]);

  credentialScan(typespec, "TypeSpec authority");
  credentialScan(authored, "JSON Schema authority");
  credentialScan(consumer, "consumer manifest");

  assert.match(typespec, /Independently authored TypeSpec authority/u);
  assert.match(typespec, /comparison evidence only/u);
  assert.equal(authored.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(authored.$id, "https://fiducia.cloud/schemas/opportunity-application.peer.schema.json");
  assert.deepEqual(Object.keys(authored.$defs).sort(), expectedIds);
  for (const id of expectedIds) {
    assert.match(typespec, new RegExp(`@id\\("${id}"\\)`, "u"));
    assert.equal(authored.$defs[id].$id, id);
  }

  assert.equal(consumer.schema, "ores.contract-ir-consumer/v1");
  assert.equal(consumer.linearIssue, "DEN-3330");
  assert.equal(consumer.repository, "fiducia-cloud/fiducia-interfaces");
  assert.equal(consumer.repositoryRole, "interfaces");
  assert.equal(consumer.canonicalAuthorityRepository, "fiducia-cloud/fiducia-interfaces");
  assert.equal(consumer.evidenceScope, "production-opportunity-application-contract");
  assert.deepEqual(consumer.expectedDeclarations, expectedDeclarations);
  assert.equal(consumer.validator.repository, "ORESoftware/typespec-json-schema-validator");
  assert.equal(consumer.validator.actionCommit, validatorCommit);
  assert.equal(consumer.validator.contractIrSchema, "ores.typespec-json-schema-validator.contract-ir/v1");
  assert.equal(consumer.authorityModel.precedence, "none");
  assert.equal(consumer.authorityModel.generatedJsonSchema, "comparison-evidence-only");
  assert.equal(consumer.admission.requirePassedReceipt, true);
  assert.equal(consumer.admission.requireAdmissibleContractIr, true);
  assert.equal(consumer.admission.requireCompleteDeclarationInventory, true);
  assert.equal(consumer.admission.requireCurrentInputs, true);
  assert.equal(consumer.admission.allowFallbackAuthority, false);
  assert.equal(consumer.policy.requirePacketShownToAlex, true);
  assert.equal(consumer.policy.requireExplicitPerPacketApproval, true);
  assert.equal(consumer.policy.allowConsequentialCommitments, false);

  const validFiles = await jsonFiles(path.join(contractRoot, "instances", "OpportunityApplicationPacket", "valid"));
  const invalidFiles = await jsonFiles(path.join(contractRoot, "instances", "OpportunityApplicationPacket", "invalid"));
  assert.ok(validFiles.length >= 3, "at least three valid cross-runtime instances are required");
  assert.ok(invalidFiles.length >= 10, "at least ten invalid cross-runtime instances are required");

  for (const file of validFiles) {
    const value = await json(file);
    credentialScan(value, path.relative(root, file));
    assert.doesNotThrow(() => validateOpportunityApplicationPacket(value), path.relative(root, file));
  }
  for (const file of invalidFiles) {
    const value = await json(file);
    credentialScan(value, path.relative(root, file));
    assert.throws(() => validateOpportunityApplicationPacket(value), undefined, path.relative(root, file));
  }

  return {
    status: "PASS",
    validator: `ORESoftware/typespec-json-schema-validator@${validatorCommit}`,
    declarations: expectedDeclarations.length,
    validInstances: validFiles.length,
    invalidInstances: invalidFiles.length,
  };
}

async function main() {
  const result = await checkOpportunityApplicationContract();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

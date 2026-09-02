#!/usr/bin/env node

import fs from "node:fs";

const generatorPath = "src/generate.mjs";
const testPath = "src/zod-runtime.test.ts";

let generator = fs.readFileSync(generatorPath, "utf8");
const importAnchor = `    'import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";',\n`;
const importReplacement = `${importAnchor}    'import addFormats from "ajv-formats";',\n`;
if (generator.split(importAnchor).length !== 2) {
  throw new Error("expected exactly one generated AJV import anchor");
}
generator = generator.replace(importAnchor, importReplacement);

const setupAnchor = `    "});",\n    "ajv.addSchema(schemaBundle, schemaBundle.$id);",\n`;
const setupReplacement = `    "});",\n    'addFormats(ajv, ["email"]);',\n    "ajv.addSchema(schemaBundle, schemaBundle.$id);",\n`;
if (generator.split(setupAnchor).length !== 2) {
  throw new Error("expected exactly one generated AJV setup anchor");
}
generator = generator.replace(setupAnchor, setupReplacement);
fs.writeFileSync(generatorPath, generator, "utf8");

let testSource = fs.readFileSync(testPath, "utf8");
const testImportAnchor = `import {\n  SyncChangeEventSchema,\n`;
const testImportReplacement = `import {\n  ContactSchema,\n  SyncChangeEventSchema,\n`;
if (testSource.split(testImportAnchor).length !== 2) {
  throw new Error("expected exactly one Zod import anchor");
}
testSource = testSource.replace(testImportAnchor, testImportReplacement);

const testName = "commercial contact email uses the canonical JSON Schema format";
if (testSource.includes(testName)) {
  throw new Error("email regression test already exists");
}
const regression = `

test("${testName}", () => {
  assert.equal(
    ContactSchema.parse({
      full_name: "Ada Lovelace",
      email: "ada@example.com",
    }).email,
    "ada@example.com",
  );
  assert.throws(() =>
    ContactSchema.parse({
      full_name: "Ada Lovelace",
      email: "not-an-email",
    }),
  );
});
`;
fs.writeFileSync(testPath, `${testSource.trimEnd()}${regression}`, "utf8");

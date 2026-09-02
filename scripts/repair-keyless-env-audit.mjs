#!/usr/bin/env node

import fs from "node:fs";

const path = ".just/env.just";
const source = fs.readFileSync(path, "utf8");
const before = "[group('env')]\nenv-check: _env-dec\n";
const after = [
  "# The audit is deliberately keyless: it inspects tracked/staged paths,",
  "# ignore policy, ciphertext shape, and private-key markers without creating",
  "# decrypted runtime state or requiring ores-sops.",
  "[group('env')]",
  "env-check:",
  "",
].join("\n");

const matches = source.split(before).length - 1;
if (matches !== 1) {
  throw new Error(`expected exactly one env-check bootstrap dependency, found ${matches}`);
}

const repaired = source.replace(before, after);
if (repaired.includes("env-check: _env-dec")) {
  throw new Error("env-check still depends on the decrypted-directory bootstrap");
}
if (!repaired.includes("env-decrypt *names: _env-dec")) {
  throw new Error("repair unexpectedly changed the decrypt bootstrap boundary");
}

fs.writeFileSync(path, repaired);

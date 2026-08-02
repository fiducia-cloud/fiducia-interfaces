import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

function exportTargets(value, targets = []) {
  if (typeof value === "string") targets.push(value);
  else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) exportTargets(nested, targets);
  }
  return targets;
}

const targets = [...new Set(exportTargets(packageJson.exports))].sort();

test("every declared package export resolves to a real repository file", async () => {
  assert.ok(targets.length > 0, "package.json must declare at least one export");
  for (const target of targets) {
    assert.match(target, /^\.\//, `export target must be package-relative: ${target}`);
    const resolved = path.resolve(root, target);
    assert.ok(
      resolved === root || resolved.startsWith(`${root}${path.sep}`),
      `export target escapes the package root: ${target}`,
    );
    await access(resolved, constants.R_OK);
  }
});

test("the npm artifact contains every export and only reviewed top-level content", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(
    npm,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(
    packed.status,
    0,
    `npm pack --dry-run failed\nstdout:\n${packed.stdout}\nstderr:\n${packed.stderr}`,
  );

  let report;
  try {
    report = JSON.parse(packed.stdout);
  } catch (error) {
    throw new Error(`npm pack did not return JSON: ${error}\n${packed.stdout}`);
  }
  assert.equal(report.length, 1, "npm pack must describe exactly one artifact");
  assert.ok(Array.isArray(report[0].files), "npm pack report is missing its file inventory");

  const files = new Set(report[0].files.map((entry) => entry.path));
  for (const target of targets) {
    const artifactPath = target.replace(/^\.\//, "");
    assert.ok(files.has(artifactPath), `declared export is absent from the npm artifact: ${target}`);
  }

  const forbiddenRoots = [
    ".github/",
    "design/",
    "node_modules/",
    "src/",
  ];
  for (const file of files) {
    for (const prefix of forbiddenRoots) {
      assert.ok(!file.startsWith(prefix), `repo-only content leaked into the npm artifact: ${file}`);
    }
    assert.doesNotMatch(file, /(^|\/)\.env(?:\.|$)/, `environment file leaked into the artifact: ${file}`);
    assert.doesNotMatch(file, /\.(?:pem|key|p12|pfx)$/i, `credential-shaped file leaked into the artifact: ${file}`);
  }

  const allowed = /^(?:package\.json|README(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?|schema\/|sql\/|generated\/)/i;
  for (const file of files) {
    assert.match(file, allowed, `unreviewed top-level artifact content: ${file}`);
  }
});

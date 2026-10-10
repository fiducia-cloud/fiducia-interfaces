import {existsSync, readdirSync} from 'node:fs';
import {resolve, join, posix} from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUNTIME_ROOTS = ['langs', 'generated', 'runtime', 'clients', 'adapters'];
const IDENT = /oreslang/i;
const SOURCE = /\.ores$/i;
const MAX_DEPTH = 18;
const MAX_ENTRIES = 40000;

function entriesUnder(root, relative, depth, out) {
  if (depth > MAX_DEPTH) throw new Error('Oreslang runtime scan exceeds depth limit');
  for (const entry of readdirSync(join(root, relative), {withFileTypes: true})) {
    const path = relative ? posix.join(relative, entry.name) : entry.name;
    // Existing symlinks are not trusted to remain within the checkout.
    if (entry.isSymbolicLink()) throw new Error('uninspected runtime-source symlink: ' + path);
    out.push({path, directory: entry.isDirectory(), source: entry.isFile()});
    if (out.length > MAX_ENTRIES) throw new Error('Oreslang runtime scan exceeds entry limit');
    if (entry.isDirectory()) entriesUnder(root, path, depth + 1, out);
  }
}

/**
 * These roots hold generated/compiled runtime implementations, not human-authored
 * TypeSpec or JSON Schema authorities. No Oreslang runtime is admitted yet.
 * A versioned source-only .ores module contract under contracts/ is allowed.
 */
export function verifyUnadmittedOreslangInterfaces(root) {
  const entries = [];
  for (const prefix of [...RUNTIME_ROOTS, 'contracts']) {
    if (!existsSync(join(root, prefix))) continue;
    entriesUnder(root, prefix, 0, entries);
  }
  for (const item of entries) {
    const segments = item.path.split('/');
    const contract = segments[0] === 'contracts';
    const runtimeContractSubtree = contract && segments.slice(1).some(s =>
      /^(?:runtime(?:-adapters)?|adapters|generated|lang(?:uages|s)?)$/i.test(s));
    if (contract && !runtimeContractSubtree) continue; // authored contract declarations
    if (IDENT.test(item.path) || (item.source && SOURCE.test(item.path))) {
      throw new Error('Oreslang runtime interface is not admitted: ' + item.path);
    }
  }
  return {scanned: entries.length, status: 'non-admitted'};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verdict = verifyUnadmittedOreslangInterfaces(repositoryRoot);
  console.log('No unsupported Oreslang interface/runtime targets admitted; entries:', verdict.scanned);
}

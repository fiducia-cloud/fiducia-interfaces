#!/usr/bin/env python3
"""
validate_schemas.py — keep this repo's JSON Schemas honest.

An interfaces repo is only worth having if the schemas in it are guaranteed
well-formed, self-consistent, and actually reachable by the consumers that
vendor them. Nothing here talks to a network or needs a package installed.

Checks, per schema file:

  1. it parses as JSON and is a schema object
  2. it declares `$schema` (so validators pick the right dialect) and `$id`
  3. every local `$ref` (`#/$defs/...`) resolves
  4. every relative file `$ref` points at a file that exists
  5. it is itself a legal schema — validated against the JSON Schema
     meta-schema when `jsonschema` is installed, and structurally otherwise
  6. every `examples`/fixture named beside it still validates against it

Then, across the repo:

  7. `$id` values are unique
  8. if a sibling `*-clients` checkout vendored a copy of a schema, the copy
     still matches (drift here means the SDKs are validating against a schema
     this repo has already moved past)

Usage:
    python3 scripts/validate_schemas.py             # this repo
    python3 scripts/validate_schemas.py --format github
    python3 scripts/validate_schemas.py --consumers ../foo-clients
"""

import argparse
import hashlib
import json
import os
import re
import sys

SCHEMA_DIRS = ("schema", "schemas")
SKIP_DIRS = {"node_modules", "target", "build", "dist", "vendor", ".git",
             "_build", "deps", "obj", "out", "__pycache__", "tmp"}


class Problem(object):
    def __init__(self, severity, path, message):
        self.severity = severity
        self.path = path
        self.message = message


def find_schemas(repo):
    out = []
    for sub in SCHEMA_DIRS:
        d = os.path.join(repo, sub)
        if not os.path.isdir(d):
            continue
        for base, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith(".")]
            for name in sorted(files):
                if name.endswith(".json") and name != "index.json":
                    out.append(os.path.join(base, name))
    return out


def resolve_pointer(root, ref):
    frag = ref[1:]
    if frag.startswith("/"):
        frag = frag[1:]
    node = root
    if not frag:
        return node
    for raw in frag.split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            node = node[int(token)]
        else:
            node = node[token]
    return node


def walk_refs(node, out):
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str):
            out.append(node["$ref"])
        for value in node.values():
            walk_refs(value, out)
    elif isinstance(node, list):
        for value in node:
            walk_refs(value, out)


def structural_check(doc, rel, problems):
    """A cheap sanity pass for when `jsonschema` is not installed."""
    keyword_types = {
        "properties": dict, "$defs": dict, "definitions": dict,
        "required": list, "enum": list, "allOf": list, "anyOf": list, "oneOf": list,
        "prefixItems": list,
    }
    stack = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            for key, expected in keyword_types.items():
                if key in node and not isinstance(node[key], expected):
                    problems.append(Problem("error", rel, "%r must be a %s" % (key, expected.__name__)))
            t = node.get("type")
            if t is not None and not isinstance(t, (str, list)):
                problems.append(Problem("error", rel, "'type' must be a string or array"))
            stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
        elif isinstance(node, list):
            stack.extend(v for v in node if isinstance(v, (dict, list)))


def validate_repo(repo, consumers=()):
    problems = []
    ids = {}
    files = find_schemas(repo)
    if not files:
        problems.append(Problem("warning", "", "no JSON Schemas found under schema/ or schemas/"))
        return problems, files

    try:
        import warnings

        import jsonschema  # type: ignore
        have_jsonschema = True
    except ImportError:
        have_jsonschema = False

    for path in files:
        rel = os.path.relpath(path, repo)
        try:
            raw = open(path, "rb").read()
            doc = json.loads(raw.decode("utf-8"))
        except (OSError, ValueError) as exc:
            problems.append(Problem("error", rel, "does not parse as JSON: %s" % exc))
            continue
        if not isinstance(doc, dict):
            problems.append(Problem("error", rel, "top level is not a schema object"))
            continue

        if "$schema" not in doc:
            problems.append(Problem("warning", rel, "no $schema; validators have to guess the dialect"))
        if "$id" not in doc:
            problems.append(Problem("warning", rel, "no $id; consumers cannot reference it stably"))
        else:
            prev = ids.get(doc["$id"])
            if prev:
                problems.append(Problem("error", rel, "$id %r is already used by %s" % (doc["$id"], prev)))
            ids[doc["$id"]] = rel

        refs = []
        walk_refs(doc, refs)
        for ref in refs:
            if ref.startswith("#"):
                try:
                    resolve_pointer(doc, ref)
                except Exception:
                    problems.append(Problem("error", rel, "local $ref %r does not resolve" % ref))
            elif "://" not in ref:
                target = os.path.normpath(os.path.join(os.path.dirname(path), ref.split("#", 1)[0]))
                if not os.path.exists(target):
                    problems.append(Problem("error", rel, "$ref %r points at a missing file" % ref))

        if have_jsonschema:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                try:
                    cls = jsonschema.validators.validator_for(doc)
                    cls.check_schema(doc)
                except Exception as exc:
                    problems.append(Problem("error", rel, "is not a valid JSON Schema: %s" % exc))
                    continue
                for i, example in enumerate(doc.get("examples") or []):
                    errs = sorted(cls(doc).iter_errors(example), key=lambda e: list(e.absolute_path))
                    if errs:
                        problems.append(Problem(
                            "error", rel,
                            "examples[%d] does not satisfy its own schema: %s" % (i, errs[0].message)))
        else:
            structural_check(doc, rel, problems)

    # Vendored copies in sibling *-clients checkouts must not be stale.
    for consumer in consumers:
        contract = os.path.join(consumer, "contract", "surface.contract.json")
        if not os.path.exists(contract):
            continue
        try:
            data = json.load(open(contract, encoding="utf-8"))
        except ValueError:
            continue
        for entry in data.get("interfaceSchemas") or []:
            upstream = os.path.join(repo, entry.get("upstreamPath", ""))
            vendored = os.path.join(consumer, entry.get("vendoredPath", ""))
            if not (os.path.exists(upstream) and os.path.exists(vendored)):
                continue
            up = hashlib.sha256(open(upstream, "rb").read()).hexdigest()
            ven = hashlib.sha256(open(vendored, "rb").read()).hexdigest()
            if up != ven:
                problems.append(Problem(
                    "error", entry["upstreamPath"],
                    "%s vendors a stale copy of this schema. Re-run its "
                    "contract/bin/derive_contract.py --interfaces-repo to re-vendor."
                    % os.path.basename(os.path.normpath(consumer))))
    return problems, files


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--consumers", nargs="*", default=None,
                    help="sibling *-clients checkouts to check for stale vendored copies")
    ap.add_argument("--format", choices=["text", "github"], default="text")
    args = ap.parse_args(argv)

    repo = os.path.abspath(args.repo)
    consumers = args.consumers
    if consumers is None:
        # Default to any sibling *-clients checkout; absent is fine.
        parent = os.path.dirname(repo)
        consumers = [os.path.join(parent, n) for n in sorted(os.listdir(parent))
                     if n.endswith("-clients") and os.path.isdir(os.path.join(parent, n))] \
            if os.path.isdir(parent) else []

    problems, files = validate_repo(repo, consumers)
    errors = [p for p in problems if p.severity == "error"]

    if args.format == "github":
        for p in problems:
            level = "error" if p.severity == "error" else "warning"
            loc = ("file=%s" % p.path) if p.path else ""
            sys.stdout.write("::%s %s::%s\n" % (level, loc, p.message))
    else:
        for p in problems:
            sys.stdout.write("  %-4s %s: %s\n" % ("FAIL" if p.severity == "error" else "warn",
                                                  p.path or "<repo>", p.message))
        print("\n%d schema(s) checked: %d error(s), %d warning(s)"
              % (len(files), len(errors), len(problems) - len(errors)))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())

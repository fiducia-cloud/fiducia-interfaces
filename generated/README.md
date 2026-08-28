<!-- generated-policy: frozen -->

# Generated files — read-only

Do **not** hand-edit files in this directory. They are produced by tooling such as:

- https://github.com/flags-2-env/flags-2-env (`f2e generate`; typical Dart path: `generated/dart/env.dart`)
- https://github.com/oresoftware/api-docs (`ridl generate`)
- interface adapters from `schema/tables.json` (`node src/generate.mjs`)
- JSON Schema / OpenAPI / route-map generators in this repository

## Disk permissions

After generation, files here are frozen with `chmod a-w` (not writable). Directories
and this `README.md` stay writable so generators can replace files.

Git does **not** persist the write bit (only the executable bit). A fresh clone is
writable until you re-freeze:

```sh
scripts/freeze-generated.sh
```

Do not `chmod u+w` and then commit a hand-edit. Change the **primary source**
(`.cli-flags.toml`, route map, OpenAPI, `schema/tables.json`, `schema/*.schema.json`)
and regenerate. Preferred generators thaw, write, then `chmod a-w` themselves.

## Gitignored trees

If `generated/` is in `.gitignore`, generated artifacts stay off VCS. Still commit
this `README.md` (`git add -f generated/README.md` or a `.gitignore` exception) so
the freeze policy is visible. Example exception:

```
generated/**
!generated/README.md
```

(Do not ignore the directory node itself as `generated/` — that prevents
the `!README.md` exception from working.)

## Runtime contract (not just compile-time)

JSON Schema 2020-12 (when present under `json-schema/`) is a **cross-check**, not
always the primary generator input. Runtime `check_os_env` / `checkOsEnv` /
`validate()` / `f2e check-contract` must pass on real payloads, not only on types
that compile. Unit tests should feed **valid** and **invalid** instances (missing
required keys, wrong types, extra properties) and compare schema keys to
`.cli-flags.toml` env names or route-map keys when those exist.

```sh
f2e check-contract --config .cli-flags.toml --json env.fixture.json
```

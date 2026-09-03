use commercial_intake_parity::{
    audit_contracts, parse_json, parse_policy, render_json_pretty, ParityError,
};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug)]
struct Options {
    typespec: PathBuf,
    json_schema: PathBuf,
    publication: PathBuf,
    policy: PathBuf,
    output: PathBuf,
    require_pass: bool,
}

fn value_after(arguments: &[String], index: &mut usize, flag: &str) -> Result<PathBuf, ParityError> {
    *index += 1;
    arguments
        .get(*index)
        .map(PathBuf::from)
        .ok_or_else(|| ParityError::from(format!("{flag} requires a path")))
}

fn parse_arguments(arguments: &[String]) -> Result<Options, ParityError> {
    let mut typespec = None;
    let mut json_schema = None;
    let mut publication = None;
    let mut policy = None;
    let mut output = None;
    let mut require_pass = false;
    let mut index = 0_usize;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--typespec" => typespec = Some(value_after(arguments, &mut index, "--typespec")?),
            "--json-schema" => {
                json_schema = Some(value_after(arguments, &mut index, "--json-schema")?)
            }
            "--publication" => {
                publication = Some(value_after(arguments, &mut index, "--publication")?)
            }
            "--policy" => policy = Some(value_after(arguments, &mut index, "--policy")?),
            "--output" => output = Some(value_after(arguments, &mut index, "--output")?),
            "--require-pass" => require_pass = true,
            unexpected => {
                return Err(ParityError::from(format!(
                    "unexpected argument {unexpected:?}"
                )))
            }
        }
        index += 1;
    }
    Ok(Options {
        typespec: typespec.ok_or_else(|| ParityError::from("--typespec is required"))?,
        json_schema: json_schema
            .ok_or_else(|| ParityError::from("--json-schema is required"))?,
        publication: publication
            .ok_or_else(|| ParityError::from("--publication is required"))?,
        policy: policy.ok_or_else(|| ParityError::from("--policy is required"))?,
        output: output.ok_or_else(|| ParityError::from("--output is required"))?,
        require_pass,
    })
}

fn read_utf8(path: &Path, label: &str) -> Result<String, ParityError> {
    fs::read_to_string(path).map_err(|error| {
        ParityError::from(format!(
            "failed to read {label} at {}: {error}",
            path.display()
        ))
    })
}

fn run() -> Result<i32, ParityError> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let options = parse_arguments(&arguments)?;
    let typespec = read_utf8(&options.typespec, "TypeSpec authority")?;
    let json_schema = read_utf8(&options.json_schema, "JSON Schema authority")?;
    let publication = read_utf8(&options.publication, "publication JSON Schema")?;
    let policy_source = read_utf8(&options.policy, "parity policy")?;
    let policy = parse_policy(&parse_json(&policy_source)?)?;
    let receipt = audit_contracts(&typespec, &json_schema, &publication, &policy)?;
    let rendered = render_json_pretty(&receipt);
    if let Some(parent) = options.output.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            ParityError::from(format!(
                "failed to create output directory {}: {error}",
                parent.display()
            ))
        })?;
    }
    fs::write(&options.output, rendered).map_err(|error| {
        ParityError::from(format!(
            "failed to write parity receipt {}: {error}",
            options.output.display()
        ))
    })?;
    let status = receipt
        .as_object("parity receipt")?
        .get("status")
        .ok_or_else(|| ParityError::from("parity receipt status is missing"))?
        .as_str("parity receipt.status")?;
    if options.require_pass && status != "PASS" {
        Ok(2)
    } else {
        Ok(0)
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

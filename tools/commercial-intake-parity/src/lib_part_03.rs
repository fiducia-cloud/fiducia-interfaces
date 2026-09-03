#[derive(Debug, Clone, PartialEq, Eq)]
struct TypeSpecField {
    required: bool,
    type_expression: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TypeSpecModel {
    fields: BTreeMap<String, TypeSpecField>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TypeSpecDocument {
    models: BTreeMap<String, TypeSpecModel>,
    enums: BTreeMap<String, BTreeSet<String>>,
}

fn declaration_name(line: &str, keyword: &str) -> Option<String> {
    let rest = line.strip_prefix(keyword)?.trim_start();
    let name: String = rest
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

fn parse_typespec(source: &str) -> Result<TypeSpecDocument> {
    enum State {
        Outside,
        Model(String, TypeSpecModel),
        Enum(String, BTreeSet<String>),
    }

    let mut document = TypeSpecDocument::default();
    let mut state = State::Outside;
    for (line_number, raw_line) in source.lines().enumerate() {
        let line = raw_line.trim();
        let current = std::mem::replace(&mut state, State::Outside);
        state = match current {
            State::Outside => {
                if line.starts_with("model ") && line.contains('{') {
                    let name = declaration_name(line, "model ").ok_or_else(|| {
                        ParityError::new(format!(
                            "invalid TypeSpec model declaration at line {}",
                            line_number + 1
                        ))
                    })?;
                    State::Model(name, TypeSpecModel::default())
                } else if line.starts_with("enum ") && line.contains('{') {
                    let name = declaration_name(line, "enum ").ok_or_else(|| {
                        ParityError::new(format!(
                            "invalid TypeSpec enum declaration at line {}",
                            line_number + 1
                        ))
                    })?;
                    State::Enum(name, BTreeSet::new())
                } else {
                    State::Outside
                }
            }
            State::Model(name, mut model) => {
                if line == "}" || line == "};" {
                    if document.models.insert(name.clone(), model).is_some() {
                        return Err(ParityError::new(format!("duplicate TypeSpec model {name}")));
                    }
                    State::Outside
                } else {
                    if !line.is_empty() && !line.starts_with('@') && line.ends_with(';') {
                        if let Some((name_part, type_part)) = line[..line.len() - 1].split_once(':') {
                            let name_part = name_part.trim();
                            if !name_part.is_empty()
                                && !name_part.chars().any(char::is_whitespace)
                            {
                                let (field_name, required) = match name_part.strip_suffix('?') {
                                    Some(value) => (value, false),
                                    None => (name_part, true),
                                };
                                if model
                                    .fields
                                    .insert(
                                        field_name.to_owned(),
                                        TypeSpecField {
                                            required,
                                            type_expression: type_part.trim().to_owned(),
                                        },
                                    )
                                    .is_some()
                                {
                                    return Err(ParityError::new(format!(
                                        "duplicate TypeSpec field {field_name} in model {name}"
                                    )));
                                }
                            }
                        }
                    }
                    State::Model(name, model)
                }
            }
            State::Enum(name, mut values) => {
                if line == "}" || line == "};" {
                    if document.enums.insert(name.clone(), values).is_some() {
                        return Err(ParityError::new(format!("duplicate TypeSpec enum {name}")));
                    }
                    State::Outside
                } else {
                    values.extend(quoted_strings(line)?);
                    State::Enum(name, values)
                }
            }
        };
    }
    if !matches!(state, State::Outside) {
        return Err(ParityError::new("unterminated TypeSpec model or enum"));
    }
    if document.models.is_empty() {
        return Err(ParityError::new("TypeSpec source contains no models"));
    }
    Ok(document)
}

fn quoted_strings(value: &str) -> Result<BTreeSet<String>> {
    let bytes = value.as_bytes();
    let mut position = 0_usize;
    let mut values = BTreeSet::new();
    while position < bytes.len() {
        if bytes[position] != b'"' {
            position += 1;
            continue;
        }
        let start = position;
        position += 1;
        let mut escaped = false;
        let mut closed = false;
        while position < bytes.len() {
            let byte = bytes[position];
            position += 1;
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == b'"' {
                let literal = &value[start..position];
                let parsed = parse_json(literal)?;
                values.insert(parsed.as_str("TypeSpec string literal")?.to_owned());
                closed = true;
                break;
            }
        }
        if !closed {
            return Err(ParityError::new("unterminated TypeSpec string literal"));
        }
    }
    Ok(values)
}

fn camel_to_snake(value: &str) -> String {
    let mut output = String::new();
    for (index, character) in value.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if index != 0 {
                output.push('_');
            }
            output.push(character.to_ascii_lowercase());
        } else {
            output.push(character);
        }
    }
    output
}

fn strip_type_wrappers(value: &str) -> &str {
    let mut result = value.trim();
    loop {
        let previous = result;
        if let Some(stripped) = result.strip_suffix("[]") {
            result = stripped.trim();
        }
        if result.starts_with('(') && result.ends_with(')') {
            result = result[1..result.len() - 1].trim();
        }
        if result == previous {
            return result;
        }
    }
}

fn typespec_enum_values(document: &TypeSpecDocument, field: &TypeSpecField) -> Result<BTreeSet<String>> {
    let direct = quoted_strings(&field.type_expression)?;
    if !direct.is_empty() {
        return Ok(direct);
    }
    let candidate = strip_type_wrappers(&field.type_expression);
    Ok(document.enums.get(candidate).cloned().unwrap_or_default())
}

fn json_pointer<'a>(root: &'a JsonValue, reference: &str) -> Result<&'a JsonValue> {
    let Some(pointer) = reference.strip_prefix("#/") else {
        return Err(ParityError::new(format!("external JSON Schema reference is forbidden: {reference}")));
    };
    let mut current = root;
    for raw_part in pointer.split('/') {
        let part = raw_part.replace("~1", "/").replace("~0", "~");
        current = required(current.as_object("JSON pointer target")?, &part, "JSON pointer target")?;
    }
    Ok(current)
}

fn resolve_schema<'a>(root: &'a JsonValue, value: &'a JsonValue) -> Result<&'a JsonValue> {
    let object = value.as_object("JSON Schema node")?;
    if let Some(reference) = object.get("$ref") {
        return json_pointer(root, reference.as_str("JSON Schema $ref")?);
    }
    Ok(value)
}

fn json_enum_values(root: &JsonValue, value: &JsonValue) -> Result<BTreeSet<String>> {
    let resolved = resolve_schema(root, value)?;
    let object = resolved.as_object("JSON Schema property")?;
    if let Some(value) = object.get("const") {
        return match value {
            JsonValue::String(value) => Ok(BTreeSet::from([value.clone()])),
            _ => Ok(BTreeSet::new()),
        };
    }
    let Some(values) = object.get("enum") else {
        return Ok(BTreeSet::new());
    };
    string_set(values, "JSON Schema enum")
}


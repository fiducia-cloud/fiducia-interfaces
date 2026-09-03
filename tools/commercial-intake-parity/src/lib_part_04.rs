#[derive(Debug, Clone, PartialEq, Eq)]
struct JsonSchemaField {
    required: bool,
    enum_values: BTreeSet<String>,
}

fn json_schema_fields(root: &JsonValue, definition_name: &str) -> Result<BTreeMap<String, JsonSchemaField>> {
    let root_object = root.as_object("JSON Schema")?;
    let definitions = required(root_object, "$defs", "JSON Schema")?.as_object("JSON Schema.$defs")?;
    let definition = required(definitions, definition_name, "JSON Schema.$defs")?;
    let definition = resolve_schema(root, definition)?;
    let definition_object = definition.as_object(&format!("JSON Schema.$defs.{definition_name}"))?;
    let properties = required(
        definition_object,
        "properties",
        &format!("JSON Schema.$defs.{definition_name}"),
    )?
    .as_object(&format!("JSON Schema.$defs.{definition_name}.properties"))?;
    let required_fields = definition_object
        .get("required")
        .map(|value| string_set(value, &format!("JSON Schema.$defs.{definition_name}.required")))
        .transpose()?
        .unwrap_or_default();
    properties
        .iter()
        .map(|(name, value)| {
            Ok((
                name.clone(),
                JsonSchemaField {
                    required: required_fields.contains(name),
                    enum_values: json_enum_values(root, value)?,
                },
            ))
        })
        .collect()
}

fn interface_block<'a>(source: &'a str, route: &str) -> Result<&'a str> {
    let marker = format!("@route(\"{route}\")");
    let route_start = source
        .find(&marker)
        .ok_or_else(|| ParityError::new(format!("TypeSpec route {route} is missing")))?;
    let interface_offset = source[route_start..]
        .find("interface ")
        .ok_or_else(|| ParityError::new(format!("TypeSpec route {route} has no interface")))?;
    let interface_start = route_start + interface_offset;
    let open_offset = source[interface_start..]
        .find('{')
        .ok_or_else(|| ParityError::new(format!("TypeSpec route {route} interface has no body")))?;
    let open = interface_start + open_offset;
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, character) in source[open..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Ok(&source[interface_start..open + offset + 1]);
                }
            }
            _ => {}
        }
    }
    Err(ParityError::new(format!("unterminated TypeSpec interface for route {route}")))
}

#[derive(Debug, Clone)]
struct ModelAudit {
    typespec_model: String,
    json_schema_definition: String,
    missing_from_typespec: BTreeSet<String>,
    missing_from_json_schema: BTreeSet<String>,
    requiredness_mismatches: BTreeSet<String>,
    enum_mismatches: BTreeSet<String>,
    source_missing: BTreeSet<String>,
}

impl ModelAudit {
    fn status(&self) -> &'static str {
        if self.missing_from_typespec.is_empty()
            && self.missing_from_json_schema.is_empty()
            && self.requiredness_mismatches.is_empty()
            && self.enum_mismatches.is_empty()
            && self.source_missing.is_empty()
        {
            "PASS"
        } else {
            "STOPPED_FOR_EVALUATION"
        }
    }

    fn discrepancy_count(&self) -> usize {
        self.missing_from_typespec.len()
            + self.missing_from_json_schema.len()
            + self.requiredness_mismatches.len()
            + self.enum_mismatches.len()
            + self.source_missing.len()
    }

    fn to_json(&self) -> JsonValue {
        object([
            ("enumMismatches".to_owned(), strings(&self.enum_mismatches)),
            (
                "jsonSchemaDefinition".to_owned(),
                string(self.json_schema_definition.clone()),
            ),
            (
                "missingFromJsonSchema".to_owned(),
                strings(&self.missing_from_json_schema),
            ),
            (
                "missingFromTypeSpec".to_owned(),
                strings(&self.missing_from_typespec),
            ),
            (
                "requirednessMismatches".to_owned(),
                strings(&self.requiredness_mismatches),
            ),
            ("sourceMissing".to_owned(), strings(&self.source_missing)),
            ("status".to_owned(), string(self.status())),
            ("typespecModel".to_owned(), string(self.typespec_model.clone())),
        ])
    }
}


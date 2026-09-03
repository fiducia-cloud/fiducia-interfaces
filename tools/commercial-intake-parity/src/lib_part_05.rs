fn audit_model_pair(
    typespec: &TypeSpecDocument,
    json_schema: &JsonValue,
    pair: &ModelPair,
) -> Result<ModelAudit> {
    let mut audit = ModelAudit {
        typespec_model: pair.typespec_model.clone(),
        json_schema_definition: pair.json_schema_definition.clone(),
        missing_from_typespec: BTreeSet::new(),
        missing_from_json_schema: BTreeSet::new(),
        requiredness_mismatches: BTreeSet::new(),
        enum_mismatches: BTreeSet::new(),
        source_missing: BTreeSet::new(),
    };
    let Some(typespec_model) = typespec.models.get(&pair.typespec_model) else {
        audit.source_missing.insert(format!("typespec:model:{}", pair.typespec_model));
        return Ok(audit);
    };
    let json_fields = match json_schema_fields(json_schema, &pair.json_schema_definition) {
        Ok(value) => value,
        Err(error) if error.to_string().contains("is required") => {
            audit
                .source_missing
                .insert(format!("json-schema:definition:{}", pair.json_schema_definition));
            return Ok(audit);
        }
        Err(error) => return Err(error),
    };

    let mut mapped_typespec_fields: BTreeMap<String, (&String, &TypeSpecField)> =
        BTreeMap::new();
    for (name, field) in &typespec_model.fields {
        let mapped = pair
            .field_renames
            .get(name)
            .cloned()
            .unwrap_or_else(|| camel_to_snake(name));
        if let Some((existing, _)) = mapped_typespec_fields.insert(mapped.clone(), (name, field)) {
            return Err(ParityError::new(format!(
                "TypeSpec fields {}.{} and {}.{} both map to {mapped}",
                pair.typespec_model, existing, pair.typespec_model, name
            )));
        }
    }

    for (mapped_name, (typespec_name, typespec_field)) in &mapped_typespec_fields {
        let Some(json_field) = json_fields.get(mapped_name) else {
            if !pair.allow_typespec_only.contains(typespec_name.as_str()) {
                audit.missing_from_json_schema.insert(format!(
                    "{}.{} -> {}.{}",
                    pair.typespec_model, typespec_name, pair.json_schema_definition, mapped_name
                ));
            }
            continue;
        };
        if typespec_field.required != json_field.required
            && !pair.allow_requiredness_mismatch.contains(typespec_name.as_str())
        {
            audit.requiredness_mismatches.insert(format!(
                "{}.{}={} vs {}.{}={}",
                pair.typespec_model,
                typespec_name,
                if typespec_field.required { "required" } else { "optional" },
                pair.json_schema_definition,
                mapped_name,
                if json_field.required { "required" } else { "optional" }
            ));
        }
        let typespec_enums = typespec_enum_values(typespec, typespec_field)?;
        if typespec_enums != json_field.enum_values
            && (!typespec_enums.is_empty() || !json_field.enum_values.is_empty())
        {
            audit.enum_mismatches.insert(format!(
                "{}.{}={:?} vs {}.{}={:?}",
                pair.typespec_model,
                typespec_name,
                typespec_enums,
                pair.json_schema_definition,
                mapped_name,
                json_field.enum_values
            ));
        }
    }

    let mapped_json_names: BTreeSet<&str> = mapped_typespec_fields.keys().map(String::as_str).collect();
    for json_name in json_fields.keys() {
        if !mapped_json_names.contains(json_name.as_str())
            && !pair.allow_json_schema_only.contains(json_name.as_str())
        {
            audit.missing_from_typespec.insert(format!(
                "{}.{}",
                pair.json_schema_definition, json_name
            ));
        }
    }
    Ok(audit)
}

#[derive(Debug, Clone)]
struct OperationAudit {
    route: String,
    subroute: Option<String>,
    method: String,
    operation: String,
    audience: String,
    discrepancies: BTreeSet<String>,
}

impl OperationAudit {
    fn status(&self) -> &'static str {
        if self.discrepancies.is_empty() {
            "PASS"
        } else {
            "STOPPED_FOR_EVALUATION"
        }
    }

    fn to_json(&self) -> JsonValue {
        object([
            ("audience".to_owned(), string(self.audience.clone())),
            ("discrepancies".to_owned(), strings(&self.discrepancies)),
            ("method".to_owned(), string(self.method.clone())),
            ("operation".to_owned(), string(self.operation.clone())),
            ("route".to_owned(), string(self.route.clone())),
            (
                "status".to_owned(),
                string(self.status()),
            ),
            (
                "subroute".to_owned(),
                self.subroute.clone().map(string).unwrap_or(JsonValue::Null),
            ),
        ])
    }
}

fn operation_signature<'a>(block: &'a str, operation: &str) -> Result<(&'a str, &'a str)> {
    let marker = format!("{operation}(");
    let start = block
        .find(&marker)
        .ok_or_else(|| ParityError::new(format!("operation {operation} is missing")))?;
    let end = block[start..]
        .find(';')
        .map(|offset| start + offset + 1)
        .ok_or_else(|| ParityError::new(format!("operation {operation} has no terminating semicolon")))?;
    let prefix_start = block[..start]
        .rfind("\n\n")
        .map(|offset| offset + 2)
        .unwrap_or(0);
    Ok((&block[prefix_start..start], &block[start..end]))
}

fn audit_operation(source: &str, requirement: &OperationRequirement) -> OperationAudit {
    let mut audit = OperationAudit {
        route: requirement.route.clone(),
        subroute: requirement.subroute.clone(),
        method: requirement.method.clone(),
        operation: requirement.operation.clone(),
        audience: requirement.audience.clone(),
        discrepancies: BTreeSet::new(),
    };
    let block = match interface_block(source, &requirement.route) {
        Ok(value) => value,
        Err(error) => {
            audit.discrepancies.insert(error.to_string());
            return audit;
        }
    };
    let (prefix, signature) = match operation_signature(block, &requirement.operation) {
        Ok(value) => value,
        Err(error) => {
            audit.discrepancies.insert(error.to_string());
            return audit;
        }
    };
    let method_marker = format!("@{}", requirement.method);
    if !prefix.contains(&method_marker) {
        audit
            .discrepancies
            .insert(format!("missing method decorator {method_marker}"));
    }
    if let Some(subroute) = &requirement.subroute {
        let route_marker = format!("@route(\"{subroute}\")");
        if !prefix.contains(&route_marker) {
            audit
                .discrepancies
                .insert(format!("missing operation route decorator {route_marker}"));
        }
    }
    for header in &requirement.headers {
        let marker = format!("@header(\"{header}\")");
        if !signature.contains(&marker) {
            audit
                .discrepancies
                .insert(format!("missing required header {header}"));
        }
    }
    if let Some(body_model) = &requirement.body_model {
        if !signature.contains("@body") || !signature.contains(body_model) {
            audit
                .discrepancies
                .insert(format!("missing body model {body_model}"));
        }
    }
    let observed_audience = if requirement.route.starts_with("/v1/admin/") {
        "admin"
    } else {
        "public"
    };
    if observed_audience != requirement.audience {
        audit.discrepancies.insert(format!(
            "audience mismatch: policy={} route-derived={observed_audience}",
            requirement.audience
        ));
    }
    audit
}

fn strings(values: &BTreeSet<String>) -> JsonValue {
    array(values.iter().cloned().map(string))
}


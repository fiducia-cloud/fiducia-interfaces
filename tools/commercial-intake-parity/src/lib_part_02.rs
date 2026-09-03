fn object(entries: impl IntoIterator<Item = (String, JsonValue)>) -> JsonValue {
    JsonValue::Object(entries.into_iter().collect())
}

fn array(values: impl IntoIterator<Item = JsonValue>) -> JsonValue {
    JsonValue::Array(values.into_iter().collect())
}

fn string(value: impl Into<String>) -> JsonValue {
    JsonValue::String(value.into())
}

fn number(value: usize) -> JsonValue {
    JsonValue::Number(value.to_string())
}

fn required<'a>(object: &'a BTreeMap<String, JsonValue>, key: &str, label: &str) -> Result<&'a JsonValue> {
    object
        .get(key)
        .ok_or_else(|| ParityError::new(format!("{label}.{key} is required")))
}

fn required_string(object: &BTreeMap<String, JsonValue>, key: &str, label: &str) -> Result<String> {
    required(object, key, label)?.as_str(&format!("{label}.{key}")).map(str::to_owned)
}

fn optional_string(object: &BTreeMap<String, JsonValue>, key: &str, label: &str) -> Result<Option<String>> {
    object
        .get(key)
        .map(|value| value.as_str(&format!("{label}.{key}")).map(str::to_owned))
        .transpose()
}

fn string_set(value: &JsonValue, label: &str) -> Result<BTreeSet<String>> {
    value
        .as_array(label)?
        .iter()
        .enumerate()
        .map(|(index, entry)| entry.as_str(&format!("{label}[{index}]")).map(str::to_owned))
        .collect()
}

fn optional_string_set(
    object: &BTreeMap<String, JsonValue>,
    key: &str,
    label: &str,
) -> Result<BTreeSet<String>> {
    object
        .get(key)
        .map(|value| string_set(value, &format!("{label}.{key}")))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn optional_string_map(
    object: &BTreeMap<String, JsonValue>,
    key: &str,
    label: &str,
) -> Result<BTreeMap<String, String>> {
    let Some(value) = object.get(key) else {
        return Ok(BTreeMap::new());
    };
    value
        .as_object(&format!("{label}.{key}"))?
        .iter()
        .map(|(source, target)| {
            target
                .as_str(&format!("{label}.{key}.{source}"))
                .map(|target| (source.clone(), target.to_owned()))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPair {
    pub typespec_model: String,
    pub json_schema_definition: String,
    pub field_renames: BTreeMap<String, String>,
    pub allow_typespec_only: BTreeSet<String>,
    pub allow_json_schema_only: BTreeSet<String>,
    pub allow_requiredness_mismatch: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationRequirement {
    pub route: String,
    pub subroute: Option<String>,
    pub method: String,
    pub operation: String,
    pub headers: BTreeSet<String>,
    pub body_model: Option<String>,
    pub audience: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationPolicy {
    pub classification: String,
    pub expected_id: String,
    pub forbidden_authority_id: String,
    pub required_definitions: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParityPolicy {
    pub format: String,
    pub expected_status: String,
    pub model_pairs: Vec<ModelPair>,
    pub operations: Vec<OperationRequirement>,
    pub publication: PublicationPolicy,
}

pub fn parse_policy(value: &JsonValue) -> Result<ParityPolicy> {
    let root = value.as_object("parity policy")?;
    let format = required_string(root, "format", "parity policy")?;
    if format != "fiducia.commercial-intake-parity-policy.v1" {
        return Err(ParityError::new(format!("unexpected parity policy format {format:?}")));
    }
    let expected_status = required_string(root, "expectedStatus", "parity policy")?;
    if expected_status != "PASS" && expected_status != "STOPPED_FOR_EVALUATION" {
        return Err(ParityError::new("parity policy expectedStatus must be PASS or STOPPED_FOR_EVALUATION"));
    }

    let model_pairs = required(root, "modelPairs", "parity policy")?
        .as_array("parity policy.modelPairs")?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let label = format!("parity policy.modelPairs[{index}]");
            let value = value.as_object(&label)?;
            Ok(ModelPair {
                typespec_model: required_string(value, "typespecModel", &label)?,
                json_schema_definition: required_string(value, "jsonSchemaDefinition", &label)?,
                field_renames: optional_string_map(value, "fieldRenames", &label)?,
                allow_typespec_only: optional_string_set(value, "allowTypeSpecOnly", &label)?,
                allow_json_schema_only: optional_string_set(value, "allowJsonSchemaOnly", &label)?,
                allow_requiredness_mismatch: optional_string_set(
                    value,
                    "allowRequirednessMismatch",
                    &label,
                )?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if model_pairs.is_empty() {
        return Err(ParityError::new("parity policy must include modelPairs"));
    }

    let operations = required(root, "operations", "parity policy")?
        .as_array("parity policy.operations")?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let label = format!("parity policy.operations[{index}]");
            let value = value.as_object(&label)?;
            let method = required_string(value, "method", &label)?.to_ascii_lowercase();
            if !matches!(method.as_str(), "get" | "post" | "put" | "patch" | "delete") {
                return Err(ParityError::new(format!("{label}.method is unsupported")));
            }
            let audience = required_string(value, "audience", &label)?;
            if audience != "public" && audience != "admin" {
                return Err(ParityError::new(format!("{label}.audience must be public or admin")));
            }
            Ok(OperationRequirement {
                route: required_string(value, "route", &label)?,
                subroute: optional_string(value, "subroute", &label)?,
                method,
                operation: required_string(value, "operation", &label)?,
                headers: optional_string_set(value, "headers", &label)?,
                body_model: optional_string(value, "bodyModel", &label)?,
                audience,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if operations.is_empty() {
        return Err(ParityError::new("parity policy must include operations"));
    }

    let publication_value = required(root, "publication", "parity policy")?
        .as_object("parity policy.publication")?;
    let publication = PublicationPolicy {
        classification: required_string(publication_value, "classification", "parity policy.publication")?,
        expected_id: required_string(publication_value, "expectedId", "parity policy.publication")?,
        forbidden_authority_id: required_string(
            publication_value,
            "forbiddenAuthorityId",
            "parity policy.publication",
        )?,
        required_definitions: string_set(
            required(publication_value, "requiredDefinitions", "parity policy.publication")?,
            "parity policy.publication.requiredDefinitions",
        )?,
    };
    if publication.classification != "distinct-lead-intake-contract" {
        return Err(ParityError::new(
            "parity policy publication.classification must be distinct-lead-intake-contract",
        ));
    }

    let mut pair_names = BTreeSet::new();
    for pair in &model_pairs {
        if !pair_names.insert((pair.typespec_model.clone(), pair.json_schema_definition.clone())) {
            return Err(ParityError::new("duplicate model pair in parity policy"));
        }
    }
    let mut operation_names = BTreeSet::new();
    for operation in &operations {
        let key = (
            operation.route.clone(),
            operation.subroute.clone(),
            operation.method.clone(),
            operation.operation.clone(),
        );
        if !operation_names.insert(key) {
            return Err(ParityError::new("duplicate operation requirement in parity policy"));
        }
    }

    Ok(ParityPolicy {
        format,
        expected_status,
        model_pairs,
        operations,
        publication,
    })
}


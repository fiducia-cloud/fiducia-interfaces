fn audit_publication(
    publication: &JsonValue,
    policy: &PublicationPolicy,
) -> Result<(JsonValue, usize)> {
    let root = publication.as_object("publication JSON Schema")?;
    let mut discrepancies = BTreeSet::new();
    let observed_draft = root
        .get("$schema")
        .map(|value| value.as_str("publication JSON Schema.$schema"))
        .transpose()?
        .unwrap_or("");
    if observed_draft != "https://json-schema.org/draft/2020-12/schema" {
        discrepancies.insert(format!(
            "publication JSON Schema draft mismatch: observed {observed_draft:?}"
        ));
    }
    let observed_id = root
        .get("$id")
        .map(|value| value.as_str("publication JSON Schema.$id"))
        .transpose()?
        .unwrap_or("");
    if observed_id != policy.expected_id {
        discrepancies.insert(format!(
            "publication $id mismatch: expected {:?}, observed {:?}",
            policy.expected_id, observed_id
        ));
    }
    if observed_id == policy.forbidden_authority_id {
        discrepancies.insert("publication incorrectly claims the lifecycle authority $id".to_owned());
    }
    let definitions = root
        .get("$defs")
        .map(|value| value.as_object("publication JSON Schema.$defs"))
        .transpose()?
        .cloned()
        .unwrap_or_default();
    for name in &policy.required_definitions {
        if !definitions.contains_key(name) {
            discrepancies.insert(format!("publication is missing required lead-intake definition {name}"));
        }
    }
    let status = if discrepancies.is_empty() {
        "PASS"
    } else {
        "STOPPED_FOR_EVALUATION"
    };
    let count = discrepancies.len();
    Ok((
        object([
            (
                "classification".to_owned(),
                string(policy.classification.clone()),
            ),
            ("discrepancies".to_owned(), strings(&discrepancies)),
            ("observedDraft".to_owned(), string(observed_draft)),
            ("observedId".to_owned(), string(observed_id)),
            ("status".to_owned(), string(status)),
        ]),
        count,
    ))
}

pub fn audit_contracts(
    typespec_source: &str,
    json_schema_source: &str,
    publication_source: &str,
    policy: &ParityPolicy,
) -> Result<JsonValue> {
    let typespec = parse_typespec(typespec_source)?;
    let json_schema = parse_json(json_schema_source)?;
    let publication = parse_json(publication_source)?;

    let schema_root = json_schema.as_object("authority JSON Schema")?;
    let schema_draft = required_string(schema_root, "$schema", "authority JSON Schema")?;
    if schema_draft != "https://json-schema.org/draft/2020-12/schema" {
        return Err(ParityError::new("authority JSON Schema must use Draft 2020-12"));
    }

    let model_audits = policy
        .model_pairs
        .iter()
        .map(|pair| audit_model_pair(&typespec, &json_schema, pair))
        .collect::<Result<Vec<_>>>()?;
    let operation_audits = policy
        .operations
        .iter()
        .map(|operation| audit_operation(typespec_source, operation))
        .collect::<Vec<_>>();
    let (publication_audit, publication_discrepancies) =
        audit_publication(&publication, &policy.publication)?;
    let publication_status = if publication_discrepancies == 0 {
        "PASS"
    } else {
        "STOPPED_FOR_EVALUATION"
    };

    let model_discrepancies: usize = model_audits.iter().map(ModelAudit::discrepancy_count).sum();
    let operation_discrepancies: usize = operation_audits
        .iter()
        .map(|audit| audit.discrepancies.len())
        .sum();
    let total_discrepancies =
        model_discrepancies + operation_discrepancies + publication_discrepancies;
    let status = if total_discrepancies == 0 {
        "PASS"
    } else {
        "STOPPED_FOR_EVALUATION"
    };
    if status != policy.expected_status {
        return Err(ParityError::new(format!(
            "computed parity status {status} does not match reviewed expectedStatus {}",
            policy.expected_status
        )));
    }

    Ok(object([
        (
            "checks".to_owned(),
            object([
                ("authorityJsonSchemaDraft".to_owned(), string("PASS")),
                (
                    "publicationClassification".to_owned(),
                    string(publication_status),
                ),
                ("typespecParse".to_owned(), string("PASS")),
            ]),
        ),
        (
            "format".to_owned(),
            string("fiducia.commercial-intake-parity-receipt.v1"),
        ),
        (
            "modelPairs".to_owned(),
            array(model_audits.iter().map(ModelAudit::to_json)),
        ),
        (
            "operations".to_owned(),
            array(operation_audits.iter().map(OperationAudit::to_json)),
        ),
        ("publication".to_owned(), publication_audit),
        ("status".to_owned(), string(status)),
        (
            "summary".to_owned(),
            object([
                ("checkedModelPairs".to_owned(), number(model_audits.len())),
                (
                    "checkedOperations".to_owned(),
                    number(operation_audits.len()),
                ),
                (
                    "modelDiscrepancies".to_owned(),
                    number(model_discrepancies),
                ),
                (
                    "operationDiscrepancies".to_owned(),
                    number(operation_discrepancies),
                ),
                (
                    "publicationDiscrepancies".to_owned(),
                    number(publication_discrepancies),
                ),
                ("totalDiscrepancies".to_owned(), number(total_discrepancies)),
            ]),
        ),
    ]))
}


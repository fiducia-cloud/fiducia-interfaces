#[cfg(test)]
mod tests {
    use super::*;

    fn policy(expected_status: &str) -> ParityPolicy {
        ParityPolicy {
            format: "fiducia.commercial-intake-parity-policy.v1".to_owned(),
            expected_status: expected_status.to_owned(),
            model_pairs: vec![ModelPair {
                typespec_model: "Request".to_owned(),
                json_schema_definition: "request".to_owned(),
                field_renames: BTreeMap::new(),
                allow_typespec_only: BTreeSet::new(),
                allow_json_schema_only: BTreeSet::new(),
                allow_requiredness_mismatch: BTreeSet::new(),
            }],
            operations: vec![OperationRequirement {
                route: "/v1/requests".to_owned(),
                subroute: None,
                method: "post".to_owned(),
                operation: "create".to_owned(),
                headers: BTreeSet::from(["Idempotency-Key".to_owned()]),
                body_model: Some("Request".to_owned()),
                audience: "public".to_owned(),
            }],
            publication: PublicationPolicy {
                classification: "distinct-lead-intake-contract".to_owned(),
                expected_id: "https://example.invalid/lead.schema.json".to_owned(),
                forbidden_authority_id: "https://example.invalid/lifecycle.schema.json".to_owned(),
                required_definitions: BTreeSet::from(["LeadRequest".to_owned()]),
            },
        }
    }

    const TYPE_SPEC: &str = r#"
model Request {
  requestId: string;
  mode?: "fast" | "safe";
}

@route("/v1/requests")
interface RequestOperations {
  @post
  create(
    @header("Idempotency-Key") idempotencyKey: string,
    @body request: Request,
  ): string;
}
"#;

    const AUTHORITY_SCHEMA: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "request": {
      "type": "object",
      "required": ["request_id"],
      "properties": {
        "request_id": {"type": "string"},
        "mode": {"enum": ["fast", "safe"]}
      }
    }
  }
}"#;

    const PUBLICATION_SCHEMA: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.invalid/lead.schema.json",
  "$defs": {
    "LeadRequest": {"type": "object", "properties": {}}
  }
}"#;

    #[test]
    fn json_parser_and_renderer_are_deterministic() {
        let parsed = parse_json(r#"{"z":1,"a":[true,"\u0061",null]}"#).expect("JSON parses");
        assert_eq!(
            render_json_pretty(&parsed),
            "{\n  \"a\": [\n    true,\n    \"a\",\n    null\n  ],\n  \"z\": 1\n}\n"
        );
    }

    #[test]
    fn matching_peer_contracts_pass() {
        let receipt = audit_contracts(
            TYPE_SPEC,
            AUTHORITY_SCHEMA,
            PUBLICATION_SCHEMA,
            &policy("PASS"),
        )
        .expect("audit passes");
        let object = receipt.as_object("receipt").expect("receipt object");
        assert_eq!(object.get("status"), Some(&string("PASS")));
    }

    #[test]
    fn missing_fields_stop_for_evaluation() {
        let authority = AUTHORITY_SCHEMA.replace(
            "\"mode\": {\"enum\": [\"fast\", \"safe\"]}",
            "\"mode\": {\"enum\": [\"fast\", \"safe\"]}, \"extra\": {\"type\": \"string\"}",
        );
        let receipt = audit_contracts(
            TYPE_SPEC,
            &authority,
            PUBLICATION_SCHEMA,
            &policy("STOPPED_FOR_EVALUATION"),
        )
        .expect("audit records mismatch");
        let rendered = render_json_pretty(&receipt);
        assert!(rendered.contains("request.extra"));
        assert!(rendered.contains("STOPPED_FOR_EVALUATION"));
    }

    #[test]
    fn expected_status_is_a_reviewed_fail_closed_guard() {
        let error = audit_contracts(
            TYPE_SPEC,
            AUTHORITY_SCHEMA,
            PUBLICATION_SCHEMA,
            &policy("STOPPED_FOR_EVALUATION"),
        )
        .expect_err("unexpected parity requires review");
        assert!(error.to_string().contains("does not match reviewed expectedStatus"));
    }

    #[test]
    fn policy_parser_rejects_duplicate_pairs() {
        let source = r#"{
          "format": "fiducia.commercial-intake-parity-policy.v1",
          "expectedStatus": "PASS",
          "modelPairs": [
            {"typespecModel":"A","jsonSchemaDefinition":"a"},
            {"typespecModel":"A","jsonSchemaDefinition":"a"}
          ],
          "operations": [
            {"route":"/v1/a","method":"get","operation":"read","audience":"public"}
          ],
          "publication": {
            "classification":"distinct-lead-intake-contract",
            "expectedId":"https://example.invalid/lead",
            "forbiddenAuthorityId":"https://example.invalid/lifecycle",
            "requiredDefinitions":["Lead"]
          }
        }"#;
        let error = parse_policy(&parse_json(source).expect("policy JSON parses"))
            .expect_err("duplicate pair is rejected");
        assert!(error.to_string().contains("duplicate model pair"));
    }
}

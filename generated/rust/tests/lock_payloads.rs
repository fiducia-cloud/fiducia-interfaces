use fiducia_interfaces::{
    DecisionPolicyKind, DecisionProposeRequest, LockAcquireManyRequest, LockGrant,
    LockReleaseManyRequest,
};
use std::collections::BTreeMap;

/// The shared cross-language wire fixtures (one source of truth, also decoded
/// by src/wire-parity.test.mjs). Path is anchored on CARGO_MANIFEST_DIR so it
/// resolves no matter where `cargo test` is invoked from.
fn fixtures() -> serde_json::Value {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lock-payloads.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
    serde_json::from_str(&text).expect("fixture file is valid JSON")
}

#[test]
fn generated_lock_payloads_round_trip_multi_key_grants() {
    let acquire = LockAcquireManyRequest {
        keys: vec!["orders/42".to_string(), "inventory/sku-7".to_string()],
        holder: Some("worker-a".to_string()),
        ttl_ms: Some(30_000),
        wait: Some(false),
    };

    let grant = LockGrant {
        acquired: true,
        lock_id: Some("lock-1".to_string()),
        fencing_token: None,
        fencing_tokens: Some(BTreeMap::from([
            ("orders/42".to_string(), 41),
            ("inventory/sku-7".to_string(), 42),
        ])),
        keys: Some(acquire.keys.clone()),
        holders: Some(1),
        max: Some(1),
        available: Some(0),
    };
    let release = LockReleaseManyRequest {
        lock_id: grant.lock_id.clone().expect("lock id"),
    };

    let encoded = serde_json::to_string(&grant).expect("serialize generated grant");
    let decoded: LockGrant = serde_json::from_str(&encoded).expect("deserialize generated grant");

    assert_eq!(release.lock_id, "lock-1");
    assert!(decoded.acquired);
    assert_eq!(decoded.keys.expect("keys"), acquire.keys);
}

#[test]
fn shared_fixture_valid_payloads_decode() {
    let fixtures = fixtures();

    let acquires = fixtures["valid"]["LockAcquireManyRequest"]
        .as_array()
        .expect("valid LockAcquireManyRequest entries");
    assert!(!acquires.is_empty(), "fixture must carry acquire payloads");
    for (i, entry) in acquires.iter().enumerate() {
        let decoded: LockAcquireManyRequest = serde_json::from_value(entry.clone())
            .unwrap_or_else(|e| panic!("valid LockAcquireManyRequest[{i}] must decode: {e}"));
        assert!(
            !decoded.keys.is_empty(),
            "decoded acquire[{i}] must keep its keys"
        );
    }
    // Spot-check field fidelity on the first entry, not just decodability.
    let first: LockAcquireManyRequest =
        serde_json::from_value(acquires[0].clone()).expect("first acquire");
    assert_eq!(first.keys, ["orders/42", "inventory/sku-7"]);
    assert_eq!(first.holder.as_deref(), Some("worker-a"));
    assert_eq!(first.ttl_ms, Some(30_000));
    assert_eq!(first.wait, Some(false));

    let proposes = fixtures["valid"]["DecisionProposeRequest"]
        .as_array()
        .expect("valid DecisionProposeRequest entries");
    assert!(!proposes.is_empty(), "fixture must carry propose payloads");
    for (i, entry) in proposes.iter().enumerate() {
        let decoded: DecisionProposeRequest = serde_json::from_value(entry.clone())
            .unwrap_or_else(|e| panic!("valid DecisionProposeRequest[{i}] must decode: {e}"));
        assert!(!decoded.options.is_empty());
    }
    let propose: DecisionProposeRequest =
        serde_json::from_value(proposes[0].clone()).expect("first propose");
    assert_eq!(propose.name, "release-942/ship");
    assert!(matches!(propose.policy.kind, DecisionPolicyKind::Plurality));
}

#[test]
fn shared_fixture_invalid_payloads_are_rejected() {
    let fixtures = fixtures();
    let invalid = fixtures["invalid"]["LockAcquireManyRequest"]
        .as_array()
        .expect("invalid LockAcquireManyRequest entries");
    assert!(!invalid.is_empty(), "fixture must carry invalid payloads");
    for (i, entry) in invalid.iter().enumerate() {
        let err = serde_json::from_value::<LockAcquireManyRequest>(entry.clone())
            .expect_err("payload missing required `keys` must NOT decode");
        assert!(
            err.to_string().contains("keys"),
            "rejection for invalid[{i}] should name the missing field, got: {err}"
        );
    }
}

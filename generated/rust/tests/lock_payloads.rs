use fiducia_interfaces::*;
use serde::de::DeserializeOwned;

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
fn generated_lock_payloads_round_trip_hardened_lifecycle() {
    let acquire = LockAcquireManyRequest {
        keys: vec!["orders/42".to_string(), "inventory/sku-7".to_string()],
        holder: "worker-a".to_string(),
        request_id: Some("attempt-union-09b2f8c4".to_string()),
        ttl_ms: Some(30_000),
        wait: Some(false),
        wait_timeout_ms: None,
    };

    let grant = LockAcquireResponse {
        acquired: true,
        queued: false,
        renewed: None,
        keys: acquire.keys.clone(),
        holder: acquire.holder.clone(),
        fencing_token: Some(41),
        lease_expires_ms: Some(1_767_225_600_000),
        position: None,
        wait_expires_ms: None,
        conflicts: None,
        revision: 120,
    };
    let release = LockReleaseRequest {
        holder: grant.holder.clone(),
        fencing_token: grant.fencing_token.expect("fencing token"),
    };
    let raced_cancel = LockCancelResponse {
        cancelled: false,
        acquired: true,
        reason: None,
        keys: grant.keys.clone(),
        holder: grant.holder.clone(),
        fencing_token: grant.fencing_token,
        lease_expires_ms: grant.lease_expires_ms,
        promoted: vec![],
        revision: 121,
    };

    let encoded = serde_json::to_string(&grant).expect("serialize generated grant");
    let decoded: LockAcquireResponse =
        serde_json::from_str(&encoded).expect("deserialize generated grant");

    assert_eq!(release.fencing_token, 41);
    assert!(decoded.acquired);
    assert_eq!(decoded.keys, acquire.keys);
    assert!(raced_cancel.acquired);
    assert_eq!(raced_cancel.fencing_token, Some(41));
}

fn assert_valid_entries<T: DeserializeOwned>(fixtures: &serde_json::Value, name: &str) {
    let entries = fixtures["valid"][name]
        .as_array()
        .unwrap_or_else(|| panic!("valid {name} entries"));
    assert!(
        !entries.is_empty(),
        "fixture must carry valid {name} entries"
    );
    for (i, entry) in entries.iter().enumerate() {
        serde_json::from_value::<T>(entry.clone())
            .unwrap_or_else(|e| panic!("valid {name}[{i}] must decode: {e}"));
    }
}

fn assert_invalid_entries<T: DeserializeOwned>(fixtures: &serde_json::Value, name: &str) {
    let entries = fixtures["invalid"][name]
        .as_array()
        .unwrap_or_else(|| panic!("invalid {name} entries"));
    assert!(
        !entries.is_empty(),
        "fixture must carry invalid {name} entries"
    );
    for (i, entry) in entries.iter().enumerate() {
        let err = serde_json::from_value::<T>(entry.clone())
            .err()
            .unwrap_or_else(|| panic!("invalid {name}[{i}] must not decode"));
        assert!(
            err.to_string().contains("missing field"),
            "invalid {name}[{i}] should identify a missing field, got: {err}"
        );
    }
}

#[test]
fn shared_fixture_valid_payloads_decode() {
    let fixtures = fixtures();

    assert_valid_entries::<LockAcquireRequest>(&fixtures, "LockAcquireRequest");
    assert_valid_entries::<LockAcquireManyRequest>(&fixtures, "LockAcquireManyRequest");
    assert_valid_entries::<LockAcquireResponse>(&fixtures, "LockAcquireResponse");
    assert_valid_entries::<LockRenewRequest>(&fixtures, "LockRenewRequest");
    assert_valid_entries::<LockRenewResponse>(&fixtures, "LockRenewResponse");
    assert_valid_entries::<LockReleaseRequest>(&fixtures, "LockReleaseRequest");
    assert_valid_entries::<LockReleaseResponse>(&fixtures, "LockReleaseResponse");
    assert_valid_entries::<LockCancelRequest>(&fixtures, "LockCancelRequest");
    assert_valid_entries::<LockCancelResponse>(&fixtures, "LockCancelResponse");
    assert_valid_entries::<SemaphoreAcquireRequest>(&fixtures, "SemaphoreAcquireRequest");
    assert_valid_entries::<SemaphoreAcquireResponse>(&fixtures, "SemaphoreAcquireResponse");
    assert_valid_entries::<SemaphoreRenewRequest>(&fixtures, "SemaphoreRenewRequest");
    assert_valid_entries::<SemaphoreRenewResponse>(&fixtures, "SemaphoreRenewResponse");
    assert_valid_entries::<SemaphoreReleaseRequest>(&fixtures, "SemaphoreReleaseRequest");
    assert_valid_entries::<SemaphoreReleaseResponse>(&fixtures, "SemaphoreReleaseResponse");
    assert_valid_entries::<SemaphoreCancelRequest>(&fixtures, "SemaphoreCancelRequest");
    assert_valid_entries::<SemaphoreCancelResponse>(&fixtures, "SemaphoreCancelResponse");
    assert_valid_entries::<FileLeaseAcquireRequest>(&fixtures, "FileLeaseAcquireRequest");
    assert_valid_entries::<FileLeaseRenewRequest>(&fixtures, "FileLeaseRenewRequest");
    assert_valid_entries::<FileLeaseQuery>(&fixtures, "FileLeaseQuery");
    assert_valid_entries::<DecisionProposeRequest>(&fixtures, "DecisionProposeRequest");

    let acquires = fixtures["valid"]["LockAcquireManyRequest"]
        .as_array()
        .expect("valid LockAcquireManyRequest entries");
    // Spot-check field fidelity on the first entry, not just decodability.
    let first: LockAcquireManyRequest =
        serde_json::from_value(acquires[0].clone()).expect("first acquire");
    assert_eq!(first.keys, ["orders/42", "inventory/sku-7"]);
    assert_eq!(first.holder, "worker-a");
    assert_eq!(first.request_id.as_deref(), Some("attempt-union-09b2f8c4"));
    assert_eq!(first.ttl_ms, Some(30_000));
    assert_eq!(first.wait, Some(false));

    let proposes = fixtures["valid"]["DecisionProposeRequest"]
        .as_array()
        .expect("valid DecisionProposeRequest entries");
    let propose: DecisionProposeRequest =
        serde_json::from_value(proposes[0].clone()).expect("first propose");
    assert_eq!(propose.name, "release-942/ship");
    assert!(matches!(propose.policy.kind, DecisionPolicyKind::Plurality));
}

#[test]
fn shared_fixture_invalid_payloads_are_rejected() {
    let fixtures = fixtures();
    assert_invalid_entries::<LockAcquireRequest>(&fixtures, "LockAcquireRequest");
    assert_invalid_entries::<LockAcquireManyRequest>(&fixtures, "LockAcquireManyRequest");
    assert_invalid_entries::<SemaphoreAcquireRequest>(&fixtures, "SemaphoreAcquireRequest");
}

use fiducia_interfaces::{LockAcquireManyRequest, LockGrant, LockReleaseManyRequest};

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
        fencing_tokens: Some(serde_json::json!({
            "orders/42": 41,
            "inventory/sku-7": 42
        })),
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
    assert_eq!(decoded.acquired, true);
    assert_eq!(decoded.keys.expect("keys"), acquire.keys);
}

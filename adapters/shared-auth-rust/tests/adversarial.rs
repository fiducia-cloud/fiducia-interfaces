use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use fiducia_shared_auth_guard::{Authority, Config, Guard, Outcome};
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use serde_json::json;

const ISSUER: &str = "https://auth.example.invalid";
const AUDIENCE: &str = "fiducia";
const PROJECT: &str = "fiducia-customer";
const SUBJECT: &str = "11111111-1111-4111-8111-111111111111";
const SESSION_ID: &str = "00000000-0000-4000-8000-000000000001";

#[derive(Clone, Copy)]
struct TokenCase {
    kid: &'static str,
    project: &'static str,
    roles: &'static [&'static str],
    audience: &'static str,
    expires_in_seconds: i64,
    shared_user_id: &'static str,
    provider: &'static str,
    provider_subject: &'static str,
    email: Option<&'static str>,
}

impl Default for TokenCase {
    fn default() -> Self {
        Self {
            kid: "test-key",
            project: PROJECT,
            roles: &["customer"],
            audience: AUDIENCE,
            expires_in_seconds: 3600,
            shared_user_id: "shared-user-1",
            provider: "supabase",
            provider_subject: SUBJECT,
            email: Some("customer@example.invalid"),
        }
    }
}

fn config() -> Config {
    Config {
        shared_auth_base: "http://127.0.0.1:1/shared".to_string(),
        issuer: ISSUER.to_string(),
        audience: AUDIENCE.to_string(),
        supabase_url: "http://127.0.0.1:1/supabase".to_string(),
        supabase_api_key: "publishable-key".to_string(),
        project: PROJECT.to_string(),
        introspect_secret: "introspect-secret".to_string(),
        required_roles: vec!["customer".to_string()],
        arm_timeout: Duration::from_millis(100),
        race_deadline: Duration::from_millis(250),
        jwks_ttl: Duration::from_secs(300),
    }
}

fn signing_key(seed: u8) -> p256::SecretKey {
    p256::SecretKey::from_slice(&[seed; 32]).expect("fixed test key is valid")
}

fn jwks(kid: &str, seed: u8) -> JwkSet {
    let key = signing_key(seed);
    let mut jwk = serde_json::to_value(key.public_key().to_jwk()).expect("serialize public JWK");
    let object = jwk.as_object_mut().expect("JWK is an object");
    object.insert("kid".to_string(), json!(kid));
    object.insert("alg".to_string(), json!("ES256"));
    object.insert("use".to_string(), json!("sig"));
    serde_json::from_value(json!({ "keys": [jwk] })).expect("deserialize JWK set")
}

fn claims(case: TokenCase) -> serde_json::Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after epoch")
        .as_secs() as i64;
    json!({
        "sub": case.shared_user_id,
        "provider": case.provider,
        "provider_tenant": case.project,
        "provider_subject": case.provider_subject,
        "project": case.project,
        "supabase_user_id": case.provider_subject,
        "sid": SESSION_ID,
        "email": case.email,
        "email_verified": true,
        "roles": case.roles,
        "iss": ISSUER,
        "aud": case.audience,
        "exp": now + case.expires_in_seconds,
    })
}

fn es256_token(case: TokenCase, seed: u8) -> String {
    let key = signing_key(seed);
    let pem = key
        .to_pkcs8_pem(LineEnding::LF)
        .expect("encode private key");
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(case.kid.to_string());
    jsonwebtoken::encode(
        &header,
        &claims(case),
        &EncodingKey::from_ec_pem(pem.as_bytes()).expect("parse EC private key"),
    )
    .expect("encode ES256 token")
}

fn hs256_token(case: TokenCase) -> String {
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some(case.kid.to_string());
    jsonwebtoken::encode(
        &header,
        &claims(case),
        &EncodingKey::from_secret(b"not-an-ec-key"),
    )
    .expect("encode HS256 token")
}

fn guard() -> Guard {
    Guard::with_static_jwks(config(), jwks("test-key", 7)).expect("valid guard")
}

#[tokio::test]
async fn blank_credentials_remain_anonymous() {
    let decision = guard().authenticate(Some(" \t\n ")).await;
    assert_eq!(decision.outcome, Outcome::Anonymous);
    assert!(decision.session_upgrade.is_none());
}

#[tokio::test]
async fn wrong_audience_is_unauthenticated() {
    let token = es256_token(
        TokenCase {
            audience: "another-service",
            ..TokenCase::default()
        },
        7,
    );
    assert_eq!(
        guard().authenticate(Some(&token)).await.outcome,
        Outcome::Unauthenticated
    );
}

#[tokio::test]
async fn expired_shared_token_is_unauthenticated() {
    let token = es256_token(
        TokenCase {
            expires_in_seconds: -3600,
            ..TokenCase::default()
        },
        7,
    );
    assert_eq!(
        guard().authenticate(Some(&token)).await.outcome,
        Outcome::Unauthenticated
    );
}

#[tokio::test]
async fn unknown_static_key_id_is_unauthenticated() {
    let token = es256_token(
        TokenCase {
            kid: "rotated-key",
            ..TokenCase::default()
        },
        7,
    );
    assert_eq!(
        guard().authenticate(Some(&token)).await.outcome,
        Outcome::Unauthenticated
    );
}

#[tokio::test]
async fn valid_key_id_with_wrong_signature_is_unauthenticated() {
    let token = es256_token(TokenCase::default(), 9);
    assert_eq!(
        guard().authenticate(Some(&token)).await.outcome,
        Outcome::Unauthenticated
    );
}

#[tokio::test]
async fn algorithm_confusion_is_rejected_before_claim_use() {
    let token = hs256_token(TokenCase::default());
    assert_eq!(
        guard().authenticate(Some(&token)).await.outcome,
        Outcome::Unauthenticated
    );
}

#[tokio::test]
async fn allowed_role_cannot_cross_provider_projects() {
    let token = es256_token(
        TokenCase {
            project: "fiducia-admin",
            ..TokenCase::default()
        },
        7,
    );
    assert_eq!(
        guard().authorize(Some(&token)).await.outcome,
        Outcome::Unauthenticated
    );
}

#[tokio::test]
async fn authentication_only_accepts_identity_without_required_role() {
    let token = es256_token(
        TokenCase {
            roles: &[],
            ..TokenCase::default()
        },
        7,
    );
    let decision = guard().authenticate(Some(&token)).await;
    let identity = decision.outcome.identity().expect("identity authenticated");
    assert_eq!(identity.authority, Authority::SharedAuth);
    assert!(identity.roles.is_empty());
    assert!(decision.session_upgrade.is_none());
}

#[tokio::test]
async fn authorization_requires_a_signed_required_role() {
    let token = es256_token(
        TokenCase {
            roles: &[],
            ..TokenCase::default()
        },
        7,
    );
    assert_eq!(
        guard().authorize(Some(&token)).await.outcome,
        Outcome::Forbidden
    );
}

#[tokio::test]
async fn malformed_identity_fields_are_unauthenticated() {
    let bad_subject = es256_token(
        TokenCase {
            shared_user_id: "shared/user",
            ..TokenCase::default()
        },
        7,
    );
    assert_eq!(
        guard().authenticate(Some(&bad_subject)).await.outcome,
        Outcome::Unauthenticated
    );

    let bad_provider = es256_token(
        TokenCase {
            provider: "oidc",
            ..TokenCase::default()
        },
        7,
    );
    assert_eq!(
        guard().authenticate(Some(&bad_provider)).await.outcome,
        Outcome::Unauthenticated
    );

    let bad_email = es256_token(
        TokenCase {
            email: Some("customer\n@example.invalid"),
            ..TokenCase::default()
        },
        7,
    );
    assert_eq!(
        guard().authenticate(Some(&bad_email)).await.outcome,
        Outcome::Unauthenticated
    );
}

#[tokio::test]
async fn oversized_shared_token_is_bounded_and_rejected() {
    let encoded_payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        json!({
            "iss": ISSUER,
            "padding": "x".repeat(17 * 1024),
        })
        .to_string(),
    );
    let token = format!("e30.{encoded_payload}.invalid");
    assert_eq!(
        guard().authenticate(Some(&token)).await.outcome,
        Outcome::Unauthenticated
    );
}

#[test]
fn invalid_configuration_fails_closed() {
    let mut duplicate_roles = config();
    duplicate_roles.required_roles = vec!["customer".to_string(), "customer".to_string()];
    let error = Guard::new(duplicate_roles)
        .err()
        .expect("duplicate roles are invalid");
    assert_eq!(error.to_string(), "required roles must be unique");

    let mut invalid_role = config();
    invalid_role.required_roles = vec!["customer/admin".to_string()];
    let error = Guard::new(invalid_role)
        .err()
        .expect("path-like role is invalid");
    assert_eq!(
        error.to_string(),
        "at least one valid required role is required"
    );

    let mut zero_timeout = config();
    zero_timeout.race_deadline = Duration::ZERO;
    let error = Guard::new(zero_timeout)
        .err()
        .expect("zero deadline is invalid");
    assert_eq!(
        error.to_string(),
        "authentication timeouts must be non-zero"
    );
}

#[test]
fn configuration_debug_output_redacts_credentials() {
    let rendered = format!("{:?}", config());
    assert!(rendered.contains("[redacted]"));
    assert!(!rendered.contains("publishable-key"));
    assert!(!rendered.contains("introspect-secret"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_local_authorization_is_consistent() {
    let guard = Arc::new(guard());
    let token = Arc::new(es256_token(TokenCase::default(), 7));
    let mut tasks = tokio::task::JoinSet::new();

    for _ in 0..32 {
        let guard = Arc::clone(&guard);
        let token = Arc::clone(&token);
        tasks.spawn(async move { guard.authorize(Some(token.as_str())).await.outcome });
    }

    while let Some(result) = tasks.join_next().await {
        assert!(matches!(
            result.expect("authorization task completed"),
            Outcome::Authenticated {
                authority: Authority::SharedAuth,
                ..
            }
        ));
    }
}

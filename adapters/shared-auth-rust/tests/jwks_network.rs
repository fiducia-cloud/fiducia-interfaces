use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use fiducia_shared_auth_guard::{Authority, Config, Guard, Outcome};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use serde_json::json;

const ISSUER: &str = "https://auth.example.invalid";
const PROJECT: &str = "fiducia-customer";
const SUBJECT: &str = "11111111-1111-4111-8111-111111111111";

#[derive(Clone)]
struct JwksServer {
    requests: Arc<AtomicUsize>,
    first: serde_json::Value,
    second: Option<serde_json::Value>,
    status: StatusCode,
}

async fn serve_jwks(State(state): State<JwksServer>) -> Response {
    let request = state.requests.fetch_add(1, Ordering::SeqCst);
    if !state.status.is_success() {
        return state.status.into_response();
    }
    let body = if request == 0 {
        state.first
    } else {
        state.second.unwrap_or(state.first)
    };
    (StatusCode::OK, Json(body)).into_response()
}

async fn start_jwks_server(state: JwksServer) -> String {
    let router = Router::new()
        .route("/.well-known/jwks.json", axum::routing::get(serve_jwks))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test JWKS server");
    let address = listener.local_addr().expect("read test server address");
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve test JWKS endpoint");
    });
    format!("http://{address}")
}

fn config(shared_auth_base: String) -> Config {
    Config {
        shared_auth_base,
        issuer: ISSUER.to_string(),
        audience: "fiducia".to_string(),
        supabase_url: "http://127.0.0.1:1/supabase".to_string(),
        supabase_api_key: "publishable-key".to_string(),
        project: PROJECT.to_string(),
        introspect_secret: "introspect-secret".to_string(),
        required_roles: vec!["customer".to_string()],
        arm_timeout: Duration::from_millis(300),
        race_deadline: Duration::from_secs(1),
        jwks_ttl: Duration::from_secs(300),
    }
}

fn signing_key(seed: u8) -> p256::SecretKey {
    p256::SecretKey::from_slice(&[seed; 32]).expect("fixed test key is valid")
}

fn jwks_value(kid: &str, seed: u8) -> serde_json::Value {
    let key = signing_key(seed);
    let mut jwk = serde_json::to_value(key.public_key().to_jwk()).expect("serialize public JWK");
    let object = jwk.as_object_mut().expect("JWK is an object");
    object.insert("kid".to_string(), json!(kid));
    object.insert("alg".to_string(), json!("ES256"));
    object.insert("use".to_string(), json!("sig"));
    json!({ "keys": [jwk] })
}

fn token(kid: &str, seed: u8) -> String {
    let key = signing_key(seed);
    let pem = key
        .to_pkcs8_pem(LineEnding::LF)
        .expect("encode private key");
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(kid.to_string());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after epoch")
        .as_secs();
    jsonwebtoken::encode(
        &header,
        &json!({
            "sub": "shared-user-1",
            "provider": "supabase",
            "provider_tenant": PROJECT,
            "provider_subject": SUBJECT,
            "project": PROJECT,
            "supabase_user_id": SUBJECT,
            "sid": "00000000-0000-4000-8000-000000000001",
            "email": "customer@example.invalid",
            "email_verified": true,
            "roles": ["customer"],
            "iss": ISSUER,
            "aud": "fiducia",
            "exp": now + 3600,
        }),
        &EncodingKey::from_ec_pem(pem.as_bytes()).expect("parse private key"),
    )
    .expect("encode test token")
}

#[tokio::test]
async fn unknown_kid_refreshes_once_and_then_authorizes() {
    let requests = Arc::new(AtomicUsize::new(0));
    let base = start_jwks_server(JwksServer {
        requests: Arc::clone(&requests),
        first: jwks_value("old-key", 5),
        second: Some(jwks_value("new-key", 7)),
        status: StatusCode::OK,
    })
    .await;
    let guard = Guard::new(config(base)).expect("valid guard");

    let decision = guard.authorize(Some(&token("new-key", 7))).await;
    assert!(matches!(
        decision.outcome,
        Outcome::Authenticated {
            authority: Authority::SharedAuth,
            ..
        }
    ));
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_first_use_fetches_one_jwks_document() {
    let requests = Arc::new(AtomicUsize::new(0));
    let base = start_jwks_server(JwksServer {
        requests: Arc::clone(&requests),
        first: jwks_value("test-key", 7),
        second: None,
        status: StatusCode::OK,
    })
    .await;
    let guard = Arc::new(Guard::new(config(base)).expect("valid guard"));
    let token = Arc::new(token("test-key", 7));
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
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unavailable_jwks_is_degraded_not_unauthenticated() {
    let guard = Guard::new(config("http://127.0.0.1:1".to_string())).expect("valid guard");
    let decision = guard.authorize(Some(&token("test-key", 7))).await;
    assert!(matches!(decision.outcome, Outcome::Degraded { .. }));
    assert!(decision.session_upgrade.is_none());
}

#[tokio::test]
async fn empty_jwks_is_degraded_not_unauthenticated() {
    let requests = Arc::new(AtomicUsize::new(0));
    let base = start_jwks_server(JwksServer {
        requests: Arc::clone(&requests),
        first: json!({ "keys": [] }),
        second: None,
        status: StatusCode::OK,
    })
    .await;
    let guard = Guard::new(config(base)).expect("valid guard");
    let decision = guard.authorize(Some(&token("test-key", 7))).await;

    assert!(matches!(decision.outcome, Outcome::Degraded { .. }));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

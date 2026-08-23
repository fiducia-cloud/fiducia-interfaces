//! Fiducia's deployable Shared Auth adapter.
//!
//! This crate implements the public Shared Auth HTTP/JWT contract without a
//! source dependency on the private Shared Auth repository. Fiducia customer and
//! admin images already pin `fiducia-interfaces`, so both applications can share
//! one audited implementation without embedding a source-control credential in
//! the container build.
//!
//! Three entry points are intentionally distinct:
//!
//! - [`Guard::authenticate`] may fall back to direct Supabase verification when
//!   Shared Auth is unavailable. This proves identity only and never invents
//!   roles or a Shared Auth session.
//! - [`Guard::authenticate_shared`] requires Shared Auth to verify or exchange
//!   the credential, but does not require a global role. This is the customer
//!   portal path: application-owned membership remains authoritative.
//! - [`Guard::authorize`] requires a role signed by Shared Auth. A directly valid
//!   provider token cannot satisfy this method; if Shared Auth is unavailable,
//!   the decision is [`Outcome::Degraded`], not privileged access.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 200;
const MAX_EMAIL_BYTES: usize = 320;

/// Which authority authenticated the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
    SharedAuth,
    Supabase,
}

/// Identity normalized across existing Shared Auth JWTs and direct Supabase
/// verification. Direct provider verification always has an empty `roles` set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub shared_user_id: String,
    pub provider: String,
    pub provider_tenant: String,
    pub provider_subject: String,
    pub project: String,
    pub supabase_user_id: String,
    pub session_id: Option<String>,
    pub email: Option<String>,
    pub email_verified: bool,
    /// Authenticator Assurance Level carried by the Shared Auth session. Direct
    /// provider verification is conservatively normalized to AAL1.
    pub assurance_level: u8,
    /// Authentication methods (`amr`) asserted by Shared Auth.
    pub auth_methods: Vec<String>,
    pub roles: Vec<String>,
    pub authority: Authority,
}

/// A newly issued Shared Auth access token suitable for an application's own
/// host-only HttpOnly cookie. No refresh token is returned by this contract.
pub struct SessionUpgrade {
    access_token: String,
    session_id: Option<String>,
}

impl SessionUpgrade {
    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn into_access_token(self) -> String {
        self.access_token
    }
}

impl fmt::Debug for SessionUpgrade {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionUpgrade")
            .field("access_token", &"[redacted]")
            .field("session_id", &self.session_id)
            .finish()
    }
}

/// Authentication/authorization result.
#[derive(Debug)]
pub enum Outcome {
    Anonymous,
    Authenticated {
        identity: Box<Identity>,
        authority: Authority,
        elapsed_ms: u64,
    },
    Unauthenticated,
    Forbidden,
    Degraded {
        reason: &'static str,
    },
}

impl Outcome {
    pub fn identity(&self) -> Option<&Identity> {
        match self {
            Self::Authenticated { identity, .. } => Some(identity.as_ref()),
            _ => None,
        }
    }

    pub fn is_authenticated(&self) -> bool {
        matches!(self, Self::Authenticated { .. })
    }
}

impl PartialEq for Outcome {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Anonymous, Self::Anonymous)
            | (Self::Unauthenticated, Self::Unauthenticated)
            | (Self::Forbidden, Self::Forbidden) => true,
            (Self::Degraded { reason: left }, Self::Degraded { reason: right }) => left == right,
            (
                Self::Authenticated {
                    identity: left,
                    authority: left_authority,
                    ..
                },
                Self::Authenticated {
                    identity: right,
                    authority: right_authority,
                    ..
                },
            ) => left == right && left_authority == right_authority,
            _ => false,
        }
    }
}

impl Eq for Outcome {}

/// Outcome plus an optional one-time browser session rotation.
#[derive(Debug)]
pub struct Decision {
    pub outcome: Outcome,
    pub session_upgrade: Option<SessionUpgrade>,
}

impl Decision {
    fn without_upgrade(outcome: Outcome) -> Self {
        Self {
            outcome,
            session_upgrade: None,
        }
    }
}

/// Fail-closed adapter configuration.
#[derive(Clone)]
pub struct Config {
    pub shared_auth_base: String,
    pub issuer: String,
    pub audience: String,
    pub supabase_url: String,
    pub supabase_api_key: String,
    pub project: String,
    pub introspect_secret: String,
    pub required_roles: Vec<String>,
    pub arm_timeout: Duration,
    pub race_deadline: Duration,
    pub jwks_ttl: Duration,
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Config")
            .field("shared_auth_base", &self.shared_auth_base)
            .field("issuer", &self.issuer)
            .field("audience", &self.audience)
            .field("supabase_url", &self.supabase_url)
            .field("supabase_api_key", &"[redacted]")
            .field("project", &self.project)
            .field("introspect_secret", &"[redacted]")
            .field("required_roles", &self.required_roles)
            .field("arm_timeout", &self.arm_timeout)
            .field("race_deadline", &self.race_deadline)
            .field("jwks_ttl", &self.jwks_ttl)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigError(&'static str);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for ConfigError {}

struct CachedJwks {
    fetched_at: Instant,
    set: Arc<JwkSet>,
}

/// Concurrent, bounded Shared Auth/Supabase guard.
pub struct Guard {
    config: Config,
    http: reqwest::Client,
    static_jwks: Option<Arc<JwkSet>>,
    jwks_cache: RwLock<Option<CachedJwks>>,
    jwks_refresh: Mutex<()>,
}

impl Guard {
    pub fn new(config: Config) -> Result<Self, ConfigError> {
        validate_config(&config)?;
        Ok(Self {
            config,
            http: reqwest::Client::new(),
            static_jwks: None,
            jwks_cache: RwLock::new(None),
            jwks_refresh: Mutex::new(()),
        })
    }

    /// Construct with a pinned key set. No JWKS network request is made.
    pub fn with_static_jwks(config: Config, jwks: JwkSet) -> Result<Self, ConfigError> {
        validate_config(&config)?;
        if jwks.keys.is_empty() {
            return Err(ConfigError(
                "Shared Auth JWKS must contain at least one key",
            ));
        }
        Ok(Self {
            config,
            http: reqwest::Client::new(),
            static_jwks: Some(Arc::new(jwks)),
            jwks_cache: RwLock::new(None),
            jwks_refresh: Mutex::new(()),
        })
    }

    pub fn project(&self) -> &str {
        &self.config.project
    }

    /// Authenticate identity. Direct provider verification is an allowed
    /// resilience path, but it returns no roles and no Shared Auth session.
    pub async fn authenticate(&self, token: Option<&str>) -> Decision {
        let Some(token) = normalized_token(token) else {
            return Decision::without_upgrade(Outcome::Anonymous);
        };
        if self.is_shared_auth_token(token) {
            return self.local_decision(token, false).await;
        }
        self.race_authentication(token).await
    }

    /// Authenticate through Shared Auth only, without requiring a global role.
    ///
    /// Existing Shared Auth tokens are verified locally against the pinned
    /// issuer/audience/project and revocation-backed JWKS contract. Provider
    /// tokens are exchanged and introspected through Shared Auth. Unlike
    /// [`Guard::authenticate`], this method never falls back to accepting a
    /// directly verified Supabase token, so an application can keep tenant
    /// authorization in its own database without making Shared Auth optional.
    pub async fn authenticate_shared(&self, token: Option<&str>) -> Decision {
        let Some(token) = normalized_token(token) else {
            return Decision::without_upgrade(Outcome::Anonymous);
        };
        if self.is_shared_auth_token(token) {
            return self.local_decision(token, false).await;
        }

        let started = Instant::now();
        match tokio::time::timeout(self.config.race_deadline, self.exchange(token, false)).await {
            Ok(Ok(exchanged)) => Decision {
                outcome: authenticated(exchanged.identity, started),
                session_upgrade: Some(exchanged.upgrade),
            },
            Ok(Err(Failure::Invalid)) => Decision::without_upgrade(Outcome::Unauthenticated),
            Ok(Err(Failure::Forbidden)) => Decision::without_upgrade(Outcome::Forbidden),
            Ok(Err(Failure::Unavailable)) => Decision::without_upgrade(Outcome::Degraded {
                reason: "Shared Auth authentication is unavailable",
            }),
            Err(_) => Decision::without_upgrade(Outcome::Degraded {
                reason: "Shared Auth authentication deadline exceeded",
            }),
        }
    }

    /// Authorize a role-signed identity. Direct provider verification never
    /// grants privilege. When the role authority is unavailable, this method
    /// returns `Degraded` even if Supabase independently proves the token valid.
    pub async fn authorize(&self, token: Option<&str>) -> Decision {
        let Some(token) = normalized_token(token) else {
            return Decision::without_upgrade(Outcome::Anonymous);
        };
        if self.is_shared_auth_token(token) {
            return self.local_decision(token, true).await;
        }
        self.race_authorization(token).await
    }

    fn is_shared_auth_token(&self, token: &str) -> bool {
        unverified_issuer(token).as_deref() == Some(self.config.issuer.as_str())
    }

    async fn local_decision(&self, token: &str, require_role: bool) -> Decision {
        let started = Instant::now();
        match self.verify_local(token).await {
            Ok(identity) if !require_role || self.has_required_role(&identity) => {
                Decision::without_upgrade(authenticated(identity, started))
            }
            Ok(_) => Decision::without_upgrade(Outcome::Forbidden),
            Err(Failure::Invalid) => Decision::without_upgrade(Outcome::Unauthenticated),
            Err(Failure::Unavailable) | Err(Failure::Forbidden) => {
                Decision::without_upgrade(Outcome::Degraded {
                    reason: "Shared Auth verification is unavailable",
                })
            }
        }
    }

    async fn race_authentication(&self, token: &str) -> Decision {
        let started = Instant::now();
        let shared = self.exchange(token, false);
        let direct = self.verify_direct(token);
        tokio::pin!(shared);
        tokio::pin!(direct);

        let race = async {
            let mut failures = Vec::with_capacity(2);
            let mut shared_done = false;
            let mut direct_done = false;
            loop {
                tokio::select! {
                    result = &mut shared, if !shared_done => {
                        shared_done = true;
                        match result {
                            Ok(exchanged) => {
                                return Decision {
                                    outcome: authenticated(exchanged.identity, started),
                                    session_upgrade: Some(exchanged.upgrade),
                                };
                            }
                            Err(failure) => failures.push(failure),
                        }
                    }
                    result = &mut direct, if !direct_done => {
                        direct_done = true;
                        match result {
                            Ok(identity) => {
                                return Decision::without_upgrade(authenticated(identity, started));
                            }
                            Err(failure) => failures.push(failure),
                        }
                    }
                    else => break,
                }
                if shared_done && direct_done {
                    break;
                }
            }
            Decision::without_upgrade(failures_to_outcome(&failures))
        };

        tokio::time::timeout(self.config.race_deadline, race)
            .await
            .unwrap_or_else(|_| {
                Decision::without_upgrade(Outcome::Degraded {
                    reason: "authentication race deadline exceeded",
                })
            })
    }

    async fn race_authorization(&self, token: &str) -> Decision {
        let started = Instant::now();
        let shared = self.exchange(token, true);
        let direct = self.verify_direct(token);
        tokio::pin!(shared);
        tokio::pin!(direct);

        let race = async {
            let mut shared_failure = None;
            let mut direct_failure = None;
            let mut direct_valid = false;
            let mut shared_done = false;
            let mut direct_done = false;

            loop {
                tokio::select! {
                    result = &mut shared, if !shared_done => {
                        shared_done = true;
                        match result {
                            Ok(exchanged) => {
                                return Decision {
                                    outcome: authenticated(exchanged.identity, started),
                                    session_upgrade: Some(exchanged.upgrade),
                                };
                            }
                            Err(Failure::Forbidden) => {
                                return Decision::without_upgrade(Outcome::Forbidden);
                            }
                            Err(failure) => shared_failure = Some(failure),
                        }
                    }
                    result = &mut direct, if !direct_done => {
                        direct_done = true;
                        match result {
                            Ok(_) => direct_valid = true,
                            Err(failure) => direct_failure = Some(failure),
                        }
                    }
                    else => break,
                }
                if shared_done && direct_done {
                    break;
                }
            }

            let outcome = match (shared_failure, direct_failure, direct_valid) {
                (Some(Failure::Invalid), Some(Failure::Invalid), false) => Outcome::Unauthenticated,
                (Some(Failure::Forbidden), _, _) => Outcome::Forbidden,
                _ => Outcome::Degraded {
                    reason: "Shared Auth role authority is unavailable",
                },
            };
            Decision::without_upgrade(outcome)
        };

        tokio::time::timeout(self.config.race_deadline, race)
            .await
            .unwrap_or_else(|_| {
                Decision::without_upgrade(Outcome::Degraded {
                    reason: "authorization race deadline exceeded",
                })
            })
    }

    async fn verify_local(&self, token: &str) -> Result<Identity, Failure> {
        if token.len() > MAX_TOKEN_BYTES {
            return Err(Failure::Invalid);
        }
        let header = decode_header(token).map_err(|_| Failure::Invalid)?;
        if header.alg != Algorithm::ES256 {
            return Err(Failure::Invalid);
        }
        let kid = header.kid.ok_or(Failure::Invalid)?;
        let initial = self.current_jwks(false).await?;
        match decode_with_jwks(token, &kid, &initial, &self.config) {
            Ok(identity) => Ok(identity),
            Err(LocalVerifyFailure::UnknownKey) if self.static_jwks.is_none() => {
                let refreshed = self.current_jwks(true).await?;
                match decode_with_jwks(token, &kid, &refreshed, &self.config) {
                    Ok(identity) => Ok(identity),
                    Err(LocalVerifyFailure::UnknownKey | LocalVerifyFailure::Invalid) => {
                        Err(Failure::Invalid)
                    }
                }
            }
            Err(LocalVerifyFailure::UnknownKey | LocalVerifyFailure::Invalid) => {
                Err(Failure::Invalid)
            }
        }
    }

    async fn current_jwks(&self, force_refresh: bool) -> Result<Arc<JwkSet>, Failure> {
        if let Some(set) = &self.static_jwks {
            return Ok(Arc::clone(set));
        }
        if !force_refresh {
            if let Some(set) = self.cached_jwks().await {
                return Ok(set);
            }
        }

        let _guard = self.jwks_refresh.lock().await;
        if !force_refresh {
            if let Some(set) = self.cached_jwks().await {
                return Ok(set);
            }
        }

        let endpoint = format!(
            "{}/.well-known/jwks.json",
            self.config.shared_auth_base.trim_end_matches('/')
        );
        let response = self
            .http
            .get(endpoint)
            .timeout(self.config.arm_timeout)
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        if !response.status().is_success() {
            return Err(Failure::Unavailable);
        }
        let set: JwkSet = response.json().await.map_err(|_| Failure::Unavailable)?;
        if set.keys.is_empty() {
            return Err(Failure::Unavailable);
        }
        let set = Arc::new(set);
        *self.jwks_cache.write().await = Some(CachedJwks {
            fetched_at: Instant::now(),
            set: Arc::clone(&set),
        });
        Ok(set)
    }

    async fn cached_jwks(&self) -> Option<Arc<JwkSet>> {
        let cache = self.jwks_cache.read().await;
        cache.as_ref().and_then(|cached| {
            (cached.fetched_at.elapsed() < self.config.jwks_ttl).then(|| Arc::clone(&cached.set))
        })
    }

    async fn exchange(&self, token: &str, require_role: bool) -> Result<Exchanged, Failure> {
        if token.len() > MAX_TOKEN_BYTES {
            return Err(Failure::Invalid);
        }
        let base = self.config.shared_auth_base.trim_end_matches('/');
        let response = self
            .http
            .post(format!("{base}/auth/exchange"))
            .bearer_auth(token)
            .timeout(self.config.arm_timeout)
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        if matches!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) {
            return Err(Failure::Invalid);
        }
        if !response.status().is_success() {
            return Err(Failure::Unavailable);
        }
        let exchange: ExchangeResponse = response.json().await.map_err(|_| Failure::Unavailable)?;
        if exchange.access_token.is_empty() || exchange.access_token.len() > MAX_TOKEN_BYTES {
            return Err(Failure::Unavailable);
        }

        let response = self
            .http
            .post(format!("{base}/auth/introspect"))
            .bearer_auth(&self.config.introspect_secret)
            .json(&serde_json::json!({ "token": exchange.access_token }))
            .timeout(self.config.arm_timeout)
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        if !response.status().is_success() {
            return Err(Failure::Unavailable);
        }
        let claims: IntrospectResponse = response.json().await.map_err(|_| Failure::Unavailable)?;
        if !coherent_exchange(&exchange, &claims, &self.config.project) {
            return Err(Failure::Invalid);
        }

        let identity = identity_from_introspection(claims, Authority::SharedAuth)?;
        if require_role && !self.has_required_role(&identity) {
            return Err(Failure::Forbidden);
        }
        let upgrade = SessionUpgrade {
            access_token: exchange.access_token,
            session_id: identity.session_id.clone(),
        };
        Ok(Exchanged { identity, upgrade })
    }

    async fn verify_direct(&self, token: &str) -> Result<Identity, Failure> {
        if token.len() > MAX_TOKEN_BYTES {
            return Err(Failure::Invalid);
        }
        let response = self
            .http
            .get(format!(
                "{}/auth/v1/user",
                self.config.supabase_url.trim_end_matches('/')
            ))
            .bearer_auth(token)
            .header("apikey", &self.config.supabase_api_key)
            .timeout(self.config.arm_timeout)
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        if matches!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) {
            return Err(Failure::Invalid);
        }
        if !response.status().is_success() {
            return Err(Failure::Unavailable);
        }
        let user: SupabaseUser = response.json().await.map_err(|_| Failure::Unavailable)?;
        if !valid_identifier(&user.id) || !valid_optional_email(user.email.as_deref()) {
            return Err(Failure::Invalid);
        }

        Ok(Identity {
            shared_user_id: format!("{}:{}", self.config.project, user.id),
            provider: "supabase".to_string(),
            provider_tenant: self.config.project.clone(),
            provider_subject: user.id.clone(),
            project: self.config.project.clone(),
            supabase_user_id: user.id,
            session_id: None,
            email: user.email,
            email_verified: user.email_confirmed_at.is_some(),
            assurance_level: 1,
            auth_methods: vec!["supabase".to_string()],
            roles: Vec::new(),
            authority: Authority::Supabase,
        })
    }

    fn has_required_role(&self, identity: &Identity) -> bool {
        identity.roles.iter().any(|role| {
            self.config
                .required_roles
                .iter()
                .any(|required| required == role)
        })
    }
}

fn validate_config(config: &Config) -> Result<(), ConfigError> {
    for (value, message) in [
        (&config.shared_auth_base, "Shared Auth base URL is required"),
        (&config.issuer, "Shared Auth issuer is required"),
        (&config.audience, "Shared Auth audience is required"),
        (&config.supabase_url, "Supabase URL is required"),
        (&config.supabase_api_key, "Supabase API key is required"),
        (&config.project, "provider project is required"),
        (
            &config.introspect_secret,
            "introspection secret is required",
        ),
    ] {
        if value.trim().is_empty() {
            return Err(ConfigError(message));
        }
    }
    reqwest::Url::parse(&config.shared_auth_base)
        .map_err(|_| ConfigError("Shared Auth base URL is invalid"))?;
    reqwest::Url::parse(&config.supabase_url)
        .map_err(|_| ConfigError("Supabase URL is invalid"))?;
    if config.arm_timeout.is_zero() || config.race_deadline.is_zero() || config.jwks_ttl.is_zero() {
        return Err(ConfigError("authentication timeouts must be non-zero"));
    }
    if config.required_roles.is_empty()
        || config
            .required_roles
            .iter()
            .any(|role| !valid_identifier(role))
    {
        return Err(ConfigError("at least one valid required role is required"));
    }
    if config
        .required_roles
        .iter()
        .enumerate()
        .any(|(index, role)| config.required_roles[..index].contains(role))
    {
        return Err(ConfigError("required roles must be unique"));
    }
    Ok(())
}

fn authenticated(identity: Identity, started: Instant) -> Outcome {
    let authority = identity.authority;
    Outcome::Authenticated {
        identity: Box::new(identity),
        authority,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

fn normalized_token(token: Option<&str>) -> Option<&str> {
    token.map(str::trim).filter(|token| !token.is_empty())
}

fn failures_to_outcome(failures: &[Failure]) -> Outcome {
    if failures.len() == 2 && failures.iter().all(|failure| *failure == Failure::Invalid) {
        Outcome::Unauthenticated
    } else {
        Outcome::Degraded {
            reason: "no authority could verify the credential",
        }
    }
}

fn decode_with_jwks(
    token: &str,
    kid: &str,
    jwks: &JwkSet,
    config: &Config,
) -> Result<Identity, LocalVerifyFailure> {
    let key = jwks
        .find(kid)
        .ok_or(LocalVerifyFailure::UnknownKey)
        .and_then(|jwk| DecodingKey::from_jwk(jwk).map_err(|_| LocalVerifyFailure::Invalid))?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.set_issuer(&[config.issuer.as_str()]);
    validation.set_audience(&[config.audience.as_str()]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.validate_exp = true;

    let claims = decode::<SharedClaims>(token, &key, &validation)
        .map_err(|_| LocalVerifyFailure::Invalid)?
        .claims;
    let identity = Identity {
        shared_user_id: claims.sub,
        provider: claims.provider,
        provider_tenant: claims.provider_tenant,
        provider_subject: claims.provider_subject,
        project: claims.project.unwrap_or_default(),
        supabase_user_id: claims.supabase_user_id.unwrap_or_default(),
        session_id: claims.sid,
        email: claims.email,
        email_verified: claims.email_verified,
        assurance_level: claims.aal,
        auth_methods: claims.amr,
        roles: claims.roles,
        authority: Authority::SharedAuth,
    };
    validate_shared_identity(identity, &config.project).map_err(|_| LocalVerifyFailure::Invalid)
}

fn identity_from_introspection(
    claims: IntrospectResponse,
    authority: Authority,
) -> Result<Identity, Failure> {
    let identity = Identity {
        shared_user_id: claims.sub,
        provider: claims.provider,
        provider_tenant: claims.provider_tenant,
        provider_subject: claims.provider_subject,
        project: claims.project.unwrap_or_default(),
        supabase_user_id: claims.supabase_user_id.unwrap_or_default(),
        session_id: claims.sid,
        email: claims.email,
        email_verified: claims.email_verified,
        assurance_level: claims.aal,
        auth_methods: claims.amr,
        roles: claims.roles,
        authority,
    };
    let project = identity.project.clone();
    validate_shared_identity(identity, &project)
}

fn validate_shared_identity(
    identity: Identity,
    expected_project: &str,
) -> Result<Identity, Failure> {
    if expected_project.is_empty()
        || identity.provider != "supabase"
        || identity.provider_tenant != expected_project
        || identity.project != expected_project
        || identity.supabase_user_id != identity.provider_subject
        || !valid_identifier(&identity.shared_user_id)
        || !valid_identifier(&identity.provider_subject)
        || !valid_optional_email(identity.email.as_deref())
        || !(1..=3).contains(&identity.assurance_level)
        || !unique_valid_identifiers(&identity.auth_methods)
        || !unique_valid_identifiers(&identity.roles)
    {
        return Err(Failure::Invalid);
    }
    Ok(identity)
}

fn coherent_exchange(
    exchange: &ExchangeResponse,
    claims: &IntrospectResponse,
    expected_project: &str,
) -> bool {
    claims.active
        && claims.sub == exchange.shared_user_id
        && claims.provider == exchange.provider
        && claims.provider_tenant == exchange.provider_tenant
        && claims.provider_subject == exchange.provider_subject
        && same_roles(&claims.roles, &exchange.roles)
        && claims.provider == "supabase"
        && claims.provider_tenant == expected_project
        && claims.project.as_deref() == Some(expected_project)
        && claims.supabase_user_id.as_deref() == Some(claims.provider_subject.as_str())
}

fn same_roles(left: &[String], right: &[String]) -> bool {
    let mut left = left.to_vec();
    let mut right = right.to_vec();
    left.sort_unstable();
    left.dedup();
    right.sort_unstable();
    right.dedup();
    left == right
}

fn valid_identifier(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

fn valid_optional_email(email: Option<&str>) -> bool {
    email.is_none_or(|email| {
        let email = email.trim();
        !email.is_empty() && email.len() <= MAX_EMAIL_BYTES && !email.chars().any(char::is_control)
    })
}

fn unique_valid_identifiers(values: &[String]) -> bool {
    values.iter().enumerate().all(|(index, value)| {
        valid_identifier(value) && !values[..index].iter().any(|seen| seen == value)
    })
}

fn unverified_issuer(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    value.get("iss")?.as_str().map(str::to_string)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Invalid,
    Unavailable,
    Forbidden,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalVerifyFailure {
    UnknownKey,
    Invalid,
}

struct Exchanged {
    identity: Identity,
    upgrade: SessionUpgrade,
}

#[derive(Deserialize)]
struct ExchangeResponse {
    access_token: String,
    shared_user_id: String,
    provider: String,
    provider_tenant: String,
    provider_subject: String,
    #[serde(default)]
    roles: Vec<String>,
}

const fn default_assurance_level() -> u8 {
    1
}

#[derive(Deserialize)]
struct IntrospectResponse {
    active: bool,
    sub: String,
    provider: String,
    provider_tenant: String,
    provider_subject: String,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    supabase_user_id: Option<String>,
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
    #[serde(default = "default_assurance_level")]
    aal: u8,
    #[serde(default)]
    amr: Vec<String>,
    #[serde(default)]
    roles: Vec<String>,
}

#[derive(Deserialize)]
struct SharedClaims {
    sub: String,
    provider: String,
    provider_tenant: String,
    provider_subject: String,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    supabase_user_id: Option<String>,
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
    #[serde(default = "default_assurance_level")]
    aal: u8,
    #[serde(default)]
    amr: Vec<String>,
    #[serde(default)]
    roles: Vec<String>,
    #[serde(rename = "exp")]
    _expires_at: u64,
}

#[derive(Deserialize)]
struct SupabaseUser {
    id: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_confirmed_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use axum::body::to_bytes;
    use axum::extract::{Request, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::{Json, Router};
    use jsonwebtoken::{EncodingKey, Header};
    use p256::pkcs8::{EncodePrivateKey, LineEnding};
    use serde_json::json;

    use super::*;

    const SUBJECT: &str = "11111111-1111-4111-8111-111111111111";

    #[derive(Clone, Copy)]
    enum Scenario {
        SharedWins,
        SharedUnavailable,
        WrongProject,
        MissingRole,
    }

    async fn authority(State(scenario): State<Scenario>, request: Request) -> Response {
        let path = request.uri().path().to_string();
        let headers = request.headers().clone();
        let (_, body) = request.into_parts();
        let body = to_bytes(body, 64 * 1024).await.unwrap();
        match path.as_str() {
            "/shared/auth/exchange" => exchange_response(scenario),
            "/shared/auth/introspect" => {
                assert_eq!(
                    headers.get("authorization").unwrap().to_str().unwrap(),
                    "Bearer introspect-secret"
                );
                let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(payload["token"], "new-shared-session");
                introspection_response(scenario)
            }
            "/supabase/auth/v1/user" => provider_response(scenario).await,
            _ => panic!("unexpected authority path {path}"),
        }
    }

    fn exchange_response(scenario: Scenario) -> Response {
        if matches!(scenario, Scenario::SharedUnavailable) {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        let project = if matches!(scenario, Scenario::WrongProject) {
            "fiducia-admin"
        } else {
            "fiducia-customer"
        };
        let roles = if matches!(scenario, Scenario::MissingRole) {
            Vec::<String>::new()
        } else {
            vec!["customer".to_string()]
        };
        (
            StatusCode::OK,
            Json(json!({
                "access_token": "new-shared-session",
                "shared_user_id": "shared-1",
                "provider": "supabase",
                "provider_tenant": project,
                "provider_subject": SUBJECT,
                "roles": roles,
            })),
        )
            .into_response()
    }

    fn introspection_response(scenario: Scenario) -> Response {
        let project = if matches!(scenario, Scenario::WrongProject) {
            "fiducia-admin"
        } else {
            "fiducia-customer"
        };
        let roles = if matches!(scenario, Scenario::MissingRole) {
            Vec::<String>::new()
        } else {
            vec!["customer".to_string()]
        };
        (
            StatusCode::OK,
            Json(json!({
                "active": true,
                "sub": "shared-1",
                "provider": "supabase",
                "provider_tenant": project,
                "provider_subject": SUBJECT,
                "project": project,
                "supabase_user_id": SUBJECT,
                "sid": "00000000-0000-4000-8000-000000000001",
                "email": "customer@example.invalid",
                "email_verified": true,
                "aal": 2,
                "amr": ["password", "totp"],
                "roles": roles,
            })),
        )
            .into_response()
    }

    async fn provider_response(scenario: Scenario) -> Response {
        if matches!(scenario, Scenario::WrongProject) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        if matches!(scenario, Scenario::SharedWins) {
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        (
            StatusCode::OK,
            Json(json!({
                "id": SUBJECT,
                "email": "customer@example.invalid",
                "email_confirmed_at": "2026-08-02T12:00:00Z",
            })),
        )
            .into_response()
    }

    async fn start_authority(scenario: Scenario) -> String {
        let router = Router::new().fallback(authority).with_state(scenario);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://{address}")
    }

    fn config(base: &str) -> Config {
        Config {
            shared_auth_base: format!("{base}/shared"),
            issuer: "https://auth.example.invalid".to_string(),
            audience: "fiducia".to_string(),
            supabase_url: format!("{base}/supabase"),
            supabase_api_key: "publishable-key".to_string(),
            project: "fiducia-customer".to_string(),
            introspect_secret: "introspect-secret".to_string(),
            required_roles: vec!["customer".to_string()],
            arm_timeout: Duration::from_millis(300),
            race_deadline: Duration::from_secs(1),
            jwks_ttl: Duration::from_secs(300),
        }
    }

    fn test_key() -> p256::SecretKey {
        p256::SecretKey::from_slice(&[7u8; 32]).unwrap()
    }

    fn static_jwks() -> JwkSet {
        let key = test_key();
        let mut jwk = serde_json::to_value(key.public_key().to_jwk()).unwrap();
        let object = jwk.as_object_mut().unwrap();
        object.insert("kid".to_string(), json!("test-key"));
        object.insert("alg".to_string(), json!("ES256"));
        object.insert("use".to_string(), json!("sig"));
        serde_json::from_value(json!({ "keys": [jwk] })).unwrap()
    }

    fn shared_token(project: &str, roles: &[&str]) -> String {
        let key = test_key();
        let pem = key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("test-key".to_string());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        jsonwebtoken::encode(
            &header,
            &json!({
                "sub": "shared-1",
                "provider": "supabase",
                "provider_tenant": project,
                "provider_subject": SUBJECT,
                "project": project,
                "supabase_user_id": SUBJECT,
                "sid": "00000000-0000-4000-8000-000000000001",
                "email": "customer@example.invalid",
                "email_verified": true,
                "aal": 2,
                "amr": ["password", "totp"],
                "roles": roles,
                "iss": "https://auth.example.invalid",
                "aud": "fiducia",
                "exp": now + 3600,
            }),
            &EncodingKey::from_ec_pem(pem.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    fn provider_token() -> String {
        let encode = |value: serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        format!(
            "{}.{}.fixture",
            encode(json!({ "alg": "ES256" })),
            encode(json!({ "iss": "https://customer.supabase.co/auth/v1" }))
        )
    }

    #[tokio::test]
    async fn existing_shared_token_verifies_locally_and_authorizes() {
        let guard = Guard::with_static_jwks(config("http://127.0.0.1:1"), static_jwks()).unwrap();
        let token = shared_token("fiducia-customer", &["customer"]);
        let decision = guard.authorize(Some(&token)).await;
        assert!(matches!(
            &decision.outcome,
            Outcome::Authenticated {
                authority: Authority::SharedAuth,
                ..
            }
        ));
        let identity = decision.outcome.identity().unwrap();
        assert_eq!(identity.assurance_level, 2);
        assert_eq!(
            identity.auth_methods,
            vec!["password".to_string(), "totp".to_string()]
        );
        assert!(decision.session_upgrade.is_none());
    }

    #[tokio::test]
    async fn strict_shared_authentication_exchanges_provider_and_preserves_assurance() {
        let base = start_authority(Scenario::SharedWins).await;
        let guard = Guard::new(config(&base)).unwrap();
        let decision = guard.authenticate_shared(Some(&provider_token())).await;
        let identity = decision.outcome.identity().unwrap();
        assert_eq!(identity.authority, Authority::SharedAuth);
        assert_eq!(identity.assurance_level, 2);
        assert_eq!(
            identity.auth_methods,
            vec!["password".to_string(), "totp".to_string()]
        );
        assert_eq!(
            decision.session_upgrade.unwrap().access_token(),
            "new-shared-session"
        );
    }

    #[tokio::test]
    async fn strict_shared_authentication_never_accepts_direct_provider_fallback() {
        let base = start_authority(Scenario::SharedUnavailable).await;
        let guard = Guard::new(config(&base)).unwrap();
        let decision = guard.authenticate_shared(Some(&provider_token())).await;
        assert!(matches!(decision.outcome, Outcome::Degraded { .. }));
        assert!(decision.session_upgrade.is_none());
    }

    #[tokio::test]
    async fn exchange_winner_returns_redacted_session_upgrade() {
        let base = start_authority(Scenario::SharedWins).await;
        let guard = Guard::new(config(&base)).unwrap();
        let decision = guard.authenticate(Some(&provider_token())).await;
        assert!(matches!(
            decision.outcome,
            Outcome::Authenticated {
                authority: Authority::SharedAuth,
                ..
            }
        ));
        let upgrade = decision.session_upgrade.unwrap();
        assert_eq!(upgrade.access_token(), "new-shared-session");
        assert!(format!("{upgrade:?}").contains("[redacted]"));
        assert!(!format!("{upgrade:?}").contains("new-shared-session"));
    }

    #[tokio::test]
    async fn authentication_survives_shared_auth_outage_without_role_or_upgrade() {
        let base = start_authority(Scenario::SharedUnavailable).await;
        let guard = Guard::new(config(&base)).unwrap();
        let decision = guard.authenticate(Some(&provider_token())).await;
        let identity = decision.outcome.identity().unwrap();
        assert_eq!(identity.authority, Authority::Supabase);
        assert!(identity.roles.is_empty());
        assert!(decision.session_upgrade.is_none());
    }

    #[tokio::test]
    async fn role_authorization_degrades_during_shared_auth_outage() {
        let base = start_authority(Scenario::SharedUnavailable).await;
        let guard = Guard::new(config(&base)).unwrap();
        let decision = guard.authorize(Some(&provider_token())).await;
        assert!(matches!(decision.outcome, Outcome::Degraded { .. }));
        assert!(decision.session_upgrade.is_none());
    }

    #[tokio::test]
    async fn shared_auth_role_denial_is_forbidden() {
        let base = start_authority(Scenario::MissingRole).await;
        let guard = Guard::new(config(&base)).unwrap();
        let decision = guard.authorize(Some(&provider_token())).await;
        assert_eq!(decision.outcome, Outcome::Forbidden);
        assert!(decision.session_upgrade.is_none());
    }

    #[tokio::test]
    async fn wrong_provider_project_is_rejected() {
        let base = start_authority(Scenario::WrongProject).await;
        let guard = Guard::new(config(&base)).unwrap();
        let decision = guard.authenticate(Some(&provider_token())).await;
        assert_eq!(decision.outcome, Outcome::Unauthenticated);
        assert!(decision.session_upgrade.is_none());
    }

    #[tokio::test]
    async fn no_token_is_anonymous_and_does_not_mint_a_session() {
        let guard = Guard::new(config("http://127.0.0.1:1")).unwrap();
        let decision = guard.authenticate(None).await;
        assert_eq!(decision.outcome, Outcome::Anonymous);
        assert!(decision.session_upgrade.is_none());
    }
}

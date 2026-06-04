use thiserror::Error;

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("tenant scope required")]
    TenantScopeRequired,
}

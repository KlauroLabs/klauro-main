use crate::errors::ServiceError;

pub async fn create_user(tenant_id: &str, email: &str) -> Result<String, ServiceError> {
    if tenant_id.is_empty() {
        return Err(ServiceError::TenantScopeRequired);
    }
    Ok(format!("{tenant_id}:{email}"))
}

pub async fn find_user_by_email(tenant_id: &str, email: &str) -> Result<Option<String>, ServiceError> {
    if tenant_id.is_empty() {
        return Err(ServiceError::TenantScopeRequired);
    }
    Ok(Some(format!("{tenant_id}:{email}")))
}

pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

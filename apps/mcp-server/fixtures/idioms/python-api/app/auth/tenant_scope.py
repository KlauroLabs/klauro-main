from fastapi import HTTPException


def require_tenant_scope(user):
    if not getattr(user, "tenant_id", None):
        raise HTTPException(status_code=403, detail="Tenant scope required")
    return user.tenant_id

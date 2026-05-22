from fastapi import HTTPException

from app.schemas.users import CreateUserRequest


async def create_user(tenant_id: str, dto: CreateUserRequest):
    if tenant_id == "":
        raise HTTPException(status_code=403, detail="Tenant required")
    return {"tenant_id": tenant_id, "email": dto.email}

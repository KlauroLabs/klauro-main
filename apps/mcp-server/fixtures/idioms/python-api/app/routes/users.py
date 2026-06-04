from fastapi import APIRouter, Depends

from app.auth.tenant_scope import require_tenant_scope
from app.schemas.users import CreateUserRequest
from app.services.users import create_user

router = APIRouter(prefix="/users")


@router.post("")
async def create_user_route(dto: CreateUserRequest, tenant_id: str = Depends(require_tenant_scope)):
    return await create_user(tenant_id, dto)

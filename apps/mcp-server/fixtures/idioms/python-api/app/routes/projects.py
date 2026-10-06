from fastapi import APIRouter, Depends

from app.auth.tenant_scope import require_tenant_scope
from app.schemas.projects import CreateProjectRequest
from app.services.projects import create_project

router = APIRouter(prefix="/projects")


@router.post("")
async def create_project_route(dto: CreateProjectRequest, tenant_id: str = Depends(require_tenant_scope)):
    return await create_project(tenant_id, dto)

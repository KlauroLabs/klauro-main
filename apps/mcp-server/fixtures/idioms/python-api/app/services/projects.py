from fastapi import HTTPException

from app.schemas.projects import CreateProjectRequest


async def create_project(tenant_id: str, dto: CreateProjectRequest):
    if tenant_id == "":
        raise HTTPException(status_code=403, detail="Tenant required")
    return {"tenant_id": tenant_id, "name": dto.name}

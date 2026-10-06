from fastapi import HTTPException


async def list_members(tenant_id: str):
    if tenant_id == "":
        raise HTTPException(status_code=403, detail="Tenant required")
    return []

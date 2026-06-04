from app.services.users import create_user
from app.schemas.users import CreateUserRequest


async def test_create_user_keeps_tenant_scope():
    dto = CreateUserRequest(email="ada@example.com", name="Ada")
    result = await create_user("tenant-1", dto)
    assert result["tenant_id"] == "tenant-1"

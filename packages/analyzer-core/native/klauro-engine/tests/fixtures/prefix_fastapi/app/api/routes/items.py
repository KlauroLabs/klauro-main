from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/")
def read_items():
    return []


@router.get("/{item_id}")
def read_item(item_id: int):
    return item_id

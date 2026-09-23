from fastapi import APIRouter

router = APIRouter(prefix="/items")


@router.get("/{id}")
def read_item(id: int):
    return {}


@router.delete("/{id}")
def delete_item(id: int):
    return {}

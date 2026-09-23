from typing import Annotated
from fastapi import APIRouter, Depends

router = APIRouter(prefix="/items")
CurrentUser = Annotated[dict, Depends(lambda: {})]


def get_current_active_superuser():
    return {}


@router.post("/")
def create_item(current_user: CurrentUser):
    return {}


@router.delete("/{id}", dependencies=[Depends(get_current_active_superuser)])
def delete_item(id: int):
    return {}


@router.post("/login")
def login(credentials: LoginCredential):
    return {}

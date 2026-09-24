from pydantic import BaseModel


class OrderRequest(BaseModel):
    total: float

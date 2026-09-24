from app.shapes import Shape


class OrderRepository:
    def all(self):
        return []


class OrderService:
    def __init__(self, repository: OrderRepository):
        self.repository = repository

    def list(self):
        return self.repository.all()


def shape_of() -> Shape:
    return Shape()

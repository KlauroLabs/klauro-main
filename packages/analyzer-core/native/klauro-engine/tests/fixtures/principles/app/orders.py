import sqlite3

from app.shapes import Shape


class OrderRepository:
    def __init__(self):
        self.connection = sqlite3.connect("orders.db")

    def all(self):
        return self.connection.execute("select id, total from orders").fetchall()


class OrderService:
    def __init__(self, repository: OrderRepository):
        self.repository = repository

    def list(self):
        return self.repository.all()


def shape_of() -> Shape:
    return Shape()

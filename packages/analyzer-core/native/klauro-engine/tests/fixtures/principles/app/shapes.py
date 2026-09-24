from app.orders import OrderService


class Shape:
    def area(self):
        return 0

    def scale(self, factor):
        return factor


class Square(Shape):
    def area(self):
        return 4

    def scale(self, factor):
        raise NotImplementedError("squares cannot be scaled")


def describe(service: OrderService):
    return service

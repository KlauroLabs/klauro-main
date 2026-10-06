class CartView:
    @classmethod
    def as_view(cls, **options):
        return cls


def checkout(request, order_id):
    return order_id


def invoice(request, number, format=None):
    return number

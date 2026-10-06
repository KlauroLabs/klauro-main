from django.urls import path, re_path
from django.views.decorators.csrf import csrf_exempt

from .views import CartView, checkout, invoice

urlpatterns = [
    re_path(
        r"^cart/$",
        csrf_exempt(CartView.as_view(strict=True)),
        name="cart",
    ),
    re_path(
        (
            r"^invoices/(?P<number>[0-9]+)/"
            r"(?:(?P<format>[a-z]+)/)?"
        ),
        invoice,
        name="invoice",
    ),
    path("checkout/<int:order_id>/", checkout, name="checkout"),
]

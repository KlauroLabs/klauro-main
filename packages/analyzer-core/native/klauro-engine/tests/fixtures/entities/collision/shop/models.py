from django.db import models

from .base import Translation


class Product(models.Model):
    name = models.CharField(max_length=40)


class ProductTranslation(Translation):
    product = models.ForeignKey(Product, on_delete=models.CASCADE)
    title = models.CharField(max_length=40)

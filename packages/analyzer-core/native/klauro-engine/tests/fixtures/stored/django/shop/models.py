from django.db import models


class Order(models.Model):
    total = models.DecimalField(max_digits=10, decimal_places=2)

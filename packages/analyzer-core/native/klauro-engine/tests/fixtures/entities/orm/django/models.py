from django.db import models


class Region(models.Model):
    name = models.CharField(max_length=40)


class Shop(models.Model):
    region = models.ForeignKey(
        Region,
        on_delete=models.CASCADE,
        related_name="shops",
    )
    owner = models.OneToOneField("Owner", on_delete=models.CASCADE)
    suppliers = models.ManyToManyField("Supplier")


class Owner(models.Model):
    name = models.CharField(max_length=40)


class Supplier(models.Model):
    name = models.CharField(max_length=40)

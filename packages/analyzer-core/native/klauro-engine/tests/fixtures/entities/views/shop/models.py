from django.db import models


class Meta(models.Model):
    class Meta:
        abstract = True

    metadata = models.JSONField(default=dict)


class Order(Meta):
    number = models.IntegerField()

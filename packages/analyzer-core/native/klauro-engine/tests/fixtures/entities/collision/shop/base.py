from django.db import models


class Translation(models.Model):
    language = models.CharField(max_length=8)

    class Meta:
        abstract = True

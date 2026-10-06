from django.db import models


class CustomSchedule(models.Model):
    import_path = models.CharField(max_length=80)

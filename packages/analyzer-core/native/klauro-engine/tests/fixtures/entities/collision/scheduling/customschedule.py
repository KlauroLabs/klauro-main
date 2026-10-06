from celery import schedules
from django.db.models import F


class CustomSchedule(schedules.BaseSchedule):
    def is_due(self, last_run_at):
        return F("due")

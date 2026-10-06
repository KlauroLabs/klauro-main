from django.utils import timezone

from .customschedule import CustomSchedule


class nightly_schedule(CustomSchedule):
    def remaining_estimate(self, last_run_at):
        return timezone.now()

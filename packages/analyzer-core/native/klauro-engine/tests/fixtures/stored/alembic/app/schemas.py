from pydantic import BaseModel


class DashboardModel(BaseModel):
    dashboard_title: str

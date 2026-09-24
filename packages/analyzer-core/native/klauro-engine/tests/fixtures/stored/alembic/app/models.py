from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Dashboard(Base):
    __tablename__ = "dashboards"
    id = Column(Integer, primary_key=True)
    dashboard_title = Column(String(500))

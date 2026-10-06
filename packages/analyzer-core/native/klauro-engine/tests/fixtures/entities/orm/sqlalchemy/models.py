from sqlalchemy import Column, Integer, ForeignKey, String
from sqlalchemy.orm import relationship, declarative_base

Base = declarative_base()


class Department(Base):
    __tablename__ = "departments"
    id = Column(Integer, primary_key=True)
    staff = relationship("Employee", back_populates="department")


class Employee(Base):
    __tablename__ = "employees"
    id = Column(Integer, primary_key=True)
    department_id = Column(Integer, ForeignKey("departments.id"))
    department = relationship("Department", back_populates="staff")
    badge = relationship("Badge", uselist=False)


class Badge(Base):
    __tablename__ = "badges"
    id = Column(Integer, primary_key=True)
    employee_id = Column(Integer, ForeignKey("employees.id"))


class Helper:
    label = Column(String)

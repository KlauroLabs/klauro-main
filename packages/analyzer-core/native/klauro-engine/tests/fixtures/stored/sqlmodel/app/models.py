from sqlmodel import Field, SQLModel


class UserBase(SQLModel):
    email: str


class UserCreate(UserBase):
    password: str


class User(UserBase, table=True):
    id: int = Field(primary_key=True)
    hashed_password: str


class UserPublic(UserBase):
    id: int

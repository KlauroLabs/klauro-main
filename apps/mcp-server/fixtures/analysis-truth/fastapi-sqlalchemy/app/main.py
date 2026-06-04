from fastapi import FastAPI, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

app = FastAPI(title="Users API")


class UserRead(BaseModel):
    id: str
    email: str


class UserCreate(BaseModel):
    email: str


def get_session():
    return Session()


@app.get("/users/{user_id}", response_model=UserRead)
def get_user(user_id: str, session: Session = Depends(get_session)):
    return session.get(UserRead, user_id)


@app.post("/users", response_model=UserRead)
def create_user(input: UserCreate, session: Session = Depends(get_session)):
    user = UserRead(id="new-user", email=input.email)
    session.add(user)
    session.commit()
    return user

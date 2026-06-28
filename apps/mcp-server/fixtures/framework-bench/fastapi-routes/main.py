from fastapi import FastAPI

app = FastAPI()


@app.get("/users")
def list_users():
    return {"users": []}


@app.post("/users")
def create_user(payload: dict):
    return {"created": True}


@app.delete("/users/{id}")
def delete_user(id: int):
    return {"deleted": id}

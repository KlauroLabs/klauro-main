from fastapi import FastAPI, Depends

app = FastAPI()


class UserRepository:
    def all(self):
        return []


def get_repo() -> UserRepository:
    return UserRepository()


class UserService:
    def __init__(self, repo: UserRepository = Depends(get_repo)):
        self.repo = repo

    def find_all(self):
        return self.repo.all()


def get_service(repo: UserRepository = Depends(get_repo)) -> UserService:
    return UserService(repo)


@app.get("/users")
def list_users(service: UserService = Depends(get_service)):
    return service.find_all()


@app.delete("/users/{id}")
def remove_user(id: int, service: UserService = Depends(get_service)):
    return {"deleted": id}

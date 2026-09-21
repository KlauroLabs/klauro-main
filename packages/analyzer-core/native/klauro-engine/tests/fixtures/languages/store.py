import os


class Session:
    def close(self, force: bool = False) -> bool:
        if force:
            raise ValueError("forced")
        return persist(self.identifier)


def persist(identifier: str) -> bool:
    return os.path.exists(identifier)

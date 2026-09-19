class Store:
    def __init__(self, name):
        self.name = name

    def slug(self):
        return self.name.lower()


def open_store(name):
    return Store(name)

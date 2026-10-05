from typing import List


class Item:
    def total(self) -> int:
        return 1


class Other:
    def total(self) -> int:
        return 2


def load() -> Item:
    return Item()


def from_a_function() -> int:
    item = load()
    return item.total()


def looped(items: List[Item]) -> int:
    count = 0
    for entry in items:
        count += entry.total()
    return count


def comprehended(items: List[Item]) -> List[int]:
    return [piece.total() for piece in items]

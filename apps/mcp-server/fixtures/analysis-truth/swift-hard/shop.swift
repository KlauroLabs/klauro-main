import Foundation

protocol Repository {
    associatedtype Item
    func fetch() -> Item
}

final class UserStore: Repository {
    @Published private var cache: [String] = []

    func fetch() -> String {
        return load()
    }

    private func load() -> String {
        return cache.first ?? "none"
    }
}

extension UserStore {
    func refresh() {
        _ = fetch()
    }
}

struct Coordinator<T> {
    let store: UserStore
    func run() {
        store.refresh()
        let _ = store.fetch()
    }
}

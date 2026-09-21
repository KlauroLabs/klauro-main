import Foundation

class Session {
    var identifier: String = ""
    var started: Int = 0

    func close(force: Bool) -> Bool {
        if force {
            return false
        }
        return persist(id: identifier)
    }

    func persist(id: String) -> Bool {
        return id.isEmpty
    }
}

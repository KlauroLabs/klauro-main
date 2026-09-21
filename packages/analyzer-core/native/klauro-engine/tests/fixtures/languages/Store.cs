using System;

namespace Fixture {
    public class Session {
        private string identifier;
        private long started;

        public bool Close(bool force) {
            if (force) {
                throw new InvalidOperationException("forced");
            }
            return Persist(identifier);
        }

        private bool Persist(string id) {
            return String.IsNullOrEmpty(id);
        }
    }
}

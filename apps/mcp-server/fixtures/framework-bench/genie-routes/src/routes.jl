using Genie, Genie.Router
using Genie.Requests

# Home page, inline do-block handler -> GET /
route("/") do
  "Welcome to Genie"
end

# Collection listing -> GET /users
route("/users", users_index)

# Single resource with a :id route param -> GET /users/:id
route("/users/:id", show_user)

# Create via explicit method keyword -> POST /users
route("/users", create_user, method = POST)

# Delete via explicit method keyword -> DELETE /users/:id
route("/users/:id", delete_user, method = DELETE)

# Health check via the @get macro form -> GET /health
@get("/health", health_check)

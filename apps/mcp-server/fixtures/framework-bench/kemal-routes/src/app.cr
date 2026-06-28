require "kemal"

# Cross-cutting middleware: Kemal applies auth here via before_all, which is NOT
# attributable to an individual route. Routes therefore report auth:false (honest).
before_all do |env|
  env.response.content_type = "application/json"
end

get "/health" do
  "ok"
end

get "/users" do |env|
  "all users"
end

get "/users/:id" do |env|
  env.params.url["id"]
end

post "/users" do |env|
  env.params.json
end

delete "/users/:id" do |env|
  "deleted #{env.params.url["id"]}"
end

ws "/socket" do |socket|
  socket.send "connected"
end

Kemal.run

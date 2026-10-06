(* Dream (OCaml) web app — route table fixture.
   Routes are registered in Dream.router; Dream.scope "/api" prefixes its nested
   routes and applies auth middleware cross-cuttingly (not per-route). *)

let home _request =
  Dream.html "Welcome"

let list_users _request =
  Dream.json "[]"

let create_user _request =
  Dream.json "{}"

let show_user request =
  let id = Dream.param request "id" in
  Dream.json id

let destroy_user _request =
  Dream.empty `No_Content

let health _request =
  Dream.json {|{"status":"ok"}|}

let () =
  Dream.run
  @@ Dream.logger
  @@ Dream.router [
    Dream.get    "/"           home;
    Dream.get    "/users"      list_users;
    Dream.post   "/users"      create_user;
    Dream.get    "/users/:id"  show_user;
    Dream.delete "/users/:id"  destroy_user;
    Dream.scope "/api" [ Dream.origin_referrer_check ] [
      Dream.get "/health" health;
    ];
  ]

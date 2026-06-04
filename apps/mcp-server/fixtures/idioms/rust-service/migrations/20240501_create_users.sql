create table users (
  id text primary key,
  tenant_id text not null,
  email text not null
);

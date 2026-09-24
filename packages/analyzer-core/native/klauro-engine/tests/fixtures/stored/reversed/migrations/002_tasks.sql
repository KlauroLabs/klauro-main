-- migrate:up
CREATE TABLE tasks (
  id serial PRIMARY KEY,
  title text
);

-- migrate:down
DROP TABLE tasks;

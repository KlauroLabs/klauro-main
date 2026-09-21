package fixture

import (
	"context"
	"database/sql"
)

type Store struct {
	db  *sql.DB
	ctx context.Context
}

func Open(path string) (*Store, error) {
	handle, err := sql.Open("postgres", path)
	return &Store{db: handle}, err
}

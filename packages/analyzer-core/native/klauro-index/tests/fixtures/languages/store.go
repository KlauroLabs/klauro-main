package store

import "database/sql"

type Session struct {
	ID      string
	Started int64
}

func (s *Session) Close(force bool) error {
	if force {
		return nil
	}
	return persist(s.ID)
}

func persist(id string) error {
	return sql.ErrNoRows
}

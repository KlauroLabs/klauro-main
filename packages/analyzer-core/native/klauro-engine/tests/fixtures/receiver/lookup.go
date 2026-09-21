package fixture

func (s *Store) Lookup(id string) string {
	var name string
	s.db.QueryRow("SELECT name FROM users WHERE id = $1", id).Scan(&name)
	return name
}

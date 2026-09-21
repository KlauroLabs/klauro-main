package store

type Store struct {
	Name string
}

func Open(name string) *Store {
	return &Store{Name: name}
}

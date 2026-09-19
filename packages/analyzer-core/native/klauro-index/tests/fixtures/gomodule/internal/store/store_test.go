package store

import "testing"

func TestOpen(t *testing.T) {
	if Open("local").Name != "local" {
		t.Fatal("name")
	}
}

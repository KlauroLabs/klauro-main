package gqlsvc

import "context"

type queryResolver struct{}
type mutationResolver struct{}

// User resolves Query.user.
func (r *queryResolver) User(ctx context.Context, id string) (*User, error) {
	return &User{ID: id}, nil
}

// Users resolves Query.users.
func (r *queryResolver) Users(ctx context.Context) ([]*User, error) {
	return nil, nil
}

// CreateUser resolves Mutation.createUser.
func (r *mutationResolver) CreateUser(ctx context.Context, email string) (*User, error) {
	return &User{Email: email}, nil
}

type User struct {
	ID    string
	Email string
}

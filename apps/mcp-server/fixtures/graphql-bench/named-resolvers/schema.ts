export const typeDefs = `#graphql
  type User { id: ID!, email: String! }
  type Query {
    user(id: ID!): User
    users: [User!]!
  }
  type Mutation {
    createUser(email: String!): User!
  }
`;

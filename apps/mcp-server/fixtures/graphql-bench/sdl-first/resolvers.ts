export const resolvers = {
  Query: {
    user: (_p: any, args: { id: string }) => findUser(args.id),
    users: () => allUsers(),
  },
  Mutation: {
    createUser: (_p: any, args: { email: string }) => makeUser(args.email),
  },
};

function user(_p: any, args: { id: string }) { return findUser(args.id); }
function users() { return allUsers(); }
function createUser(_p: any, args: { email: string }) { return makeUser(args.email); }

export const resolvers = {
  Query: { user, users },
  Mutation: { createUser },
};

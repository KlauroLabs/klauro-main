import { Resolver, Query, Mutation, Arg } from 'type-graphql';

@Resolver()
export class UserResolver {
  @Query(() => [String])
  async users() {
    return allUsers();
  }

  @Query(() => String)
  async user(@Arg('id') id: string) {
    return findUser(id);
  }

  @Mutation(() => String)
  async createUser(@Arg('email') email: string) {
    return makeUser(email);
  }
}

declare function allUsers(): string[];
declare function findUser(id: string): string;
declare function makeUser(email: string): string;

import { Resolver, Query, ResolveField, Root, Arg } from 'type-graphql';

@Resolver(() => User)
export class UserResolver {
  @Query(() => [User])
  async users() {
    return allUsers();
  }

  @Query(() => User)
  async user(@Arg('id') id: string) {
    return findUser(id);
  }

  @ResolveField(() => [Post])
  async posts(@Root() user: User) {
    return postsFor(user.id);
  }
}

class User { id!: string; }
class Post {}
declare function allUsers(): User[];
declare function findUser(id: string): User;
declare function postsFor(id: string): Post[];

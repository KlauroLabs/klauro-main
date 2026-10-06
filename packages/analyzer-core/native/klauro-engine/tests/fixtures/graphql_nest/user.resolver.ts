import { Resolver, Query, Mutation, ResolveField, Args, Parent } from '@nestjs/graphql';
@Resolver('User')
export class UserResolver {
  @Query('user')
  async findOne(@Args('id') id: string) { return id; }
  @Mutation(() => String, { name: 'makeUser' })
  create() { return 1; }
  @ResolveField('posts')
  posts(@Parent() u) { return []; }
}

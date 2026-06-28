import { Entity, PrimaryKey, OneToMany, ManyToOne, Collection } from '@mikro-orm/core';

@Entity()
export class User {
  @PrimaryKey()
  id!: number;

  @OneToMany(() => Post, post => post.user)
  posts = new Collection<Post>(this);
}

@Entity()
export class Post {
  @PrimaryKey()
  id!: number;

  @ManyToOne(() => User)
  user!: User;
}

import { Schema, model, Types } from 'mongoose';

const userSchema = new Schema({
  email: { type: String, unique: true },
  posts: [{ type: Types.ObjectId, ref: 'Post' }],
});

const postSchema = new Schema({
  title: { type: String },
  author: { type: Types.ObjectId, ref: 'User' },
});

export const User = model('User', userSchema);
export const Post = model('Post', postSchema);

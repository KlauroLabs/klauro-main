import { applyDecorators, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

export function ApiPost(path: string) {
  return applyDecorators(Post(path), ApiBearerAuth('Authorization'));
}

# ONE Dockerfile, ONE build for the whole Next app (pages + API routes together).
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install && npm run build
CMD ["npm", "start"]

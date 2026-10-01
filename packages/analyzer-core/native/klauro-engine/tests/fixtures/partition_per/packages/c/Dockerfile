FROM node:20
WORKDIR /app
COPY packages/c/package.json ./
COPY packages/c/src ./src
CMD ["node", "src/server.js"]

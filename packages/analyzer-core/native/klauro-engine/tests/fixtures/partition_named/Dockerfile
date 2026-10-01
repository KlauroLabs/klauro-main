FROM node:20
WORKDIR /app
COPY package.json ./
COPY packages/a ./packages/a
COPY packages/b ./packages/b
CMD ["node", "packages/b/src/index.js"]

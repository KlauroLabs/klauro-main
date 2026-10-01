FROM node:20
WORKDIR /app
COPY package.json ./
COPY packages/orders ./packages/orders
CMD ["node", "packages/orders/src/server.js"]

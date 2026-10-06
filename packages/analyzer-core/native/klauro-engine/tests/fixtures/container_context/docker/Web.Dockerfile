FROM node:20-slim
COPY . .
CMD ["node", "apps/web/src/index.js"]

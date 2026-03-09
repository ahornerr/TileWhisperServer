FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

EXPOSE 2376

ENV NODE_ENV=production

CMD ["node", "server.js"]

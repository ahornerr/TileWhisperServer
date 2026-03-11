FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js stats.js stats.html runescape_bold.woff2 ./

EXPOSE 2376
EXPOSE 8888

ENV NODE_ENV=production

CMD ["node", "server.js"]

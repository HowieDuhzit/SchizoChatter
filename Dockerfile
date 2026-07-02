FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY vite.config.js ./
COPY index.html ./
COPY src/ ./src/
COPY public/ ./public/

RUN npm run build

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY images/ ./images/
COPY --from=build /app/dist/ ./dist/

EXPOSE 80

ENV NODE_ENV=production
ENV PORT=80

CMD ["node", "server/index.js"]

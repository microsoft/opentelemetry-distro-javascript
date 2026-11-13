FROM node:22.23.4-bookworm-slim

RUN node -e "if (process.versions.node !== '22.23.4') throw new Error('Expected Node.js 22.23.4');"

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app.mjs telemetry.mjs ./

ENV NODE_OPTIONS=--import=./telemetry.mjs

USER node

EXPOSE 3000

CMD ["node", "app.mjs"]

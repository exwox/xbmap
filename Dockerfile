FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8787/api/v1/health || exit 1

CMD ["npm", "start"]

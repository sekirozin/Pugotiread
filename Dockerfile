FROM node:20-alpine AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++ unzip

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app
RUN apk add --no-cache python3 make g++ unzip
ENV NODE_ENV=production
ENV PORT=8099
ENV DATA_FILE=/app/data/store.json
ENV DB_FILE=/app/data/store.db
ENV CACHE_DIR=/app/data/cache
ENV PUBLIC_DIR=/app/public
ENV CLIENT_DIR=/app/dist/client
ENV MEDIA_ROOT=/media

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public
COPY icons ./icons
COPY data ./data

EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8099') + '/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npm", "start"]

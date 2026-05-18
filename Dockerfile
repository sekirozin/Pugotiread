FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8099
ENV DATA_FILE=/app/data/store.json
ENV PUBLIC_DIR=/app/public
ENV CLIENT_DIR=/app/dist/client
ENV MEDIA_ROOT=/media

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public
COPY data ./data

EXPOSE 8099
CMD ["npm", "start"]

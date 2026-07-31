# Single-image build: compile the client, then run the one Node process that serves both the
# built SPA and the /api routes. The server runs via tsx, so dev deps (tsx) are kept at runtime.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# ANTHROPIC_API_KEY (and any overrides) must be provided at runtime, e.g. `docker run --env-file .env`.
CMD ["npm", "start"]

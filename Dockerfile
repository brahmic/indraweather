FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian_trusted_root_ca.crt
WORKDIR /app
COPY certs/russian_trusted_root_ca.crt /usr/local/share/ca-certificates/
RUN apk add --no-cache ca-certificates ffmpeg font-noto && update-ca-certificates
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY config ./config
COPY migrations ./migrations
RUN mkdir -p /var/lib/indra/satellite-animation && chown -R node:node /var/lib/indra
USER node
CMD ["node", "dist/src/index.js"]

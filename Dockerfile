FROM node:22-alpine AS dependencies
WORKDIR /app
RUN apk add --no-cache bash coreutils
COPY package.json package-lock.json ./
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM dependencies AS builder
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist/standalone ./dist/standalone
COPY --from=builder /app/tools ./tools

EXPOSE 3000
EXPOSE 4141
CMD ["node", "dist/standalone/server.js"]

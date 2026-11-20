FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace backend --include-workspace-root
COPY backend backend
RUN npm run build -w backend && npm prune --omit=dev --workspace backend --include-workspace-root
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/backend/dist backend/dist
USER node
EXPOSE 3100
CMD ["node", "backend/dist/main.js"]

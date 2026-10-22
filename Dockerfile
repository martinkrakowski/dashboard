# syntax=docker/dockerfile:1.7
# The discovery service: Node 22, standard library only, so no install step and no node_modules.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package.json src/ ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]

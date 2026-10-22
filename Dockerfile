# syntax=docker/dockerfile:1.7
# The discovery service: Node 22, standard library only, so no install step and no node_modules.
# uid 1000 by number: Pod Security `restricted` can verify a numeric user, not a named one.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 src/ ./src/
USER 1000
EXPOSE 8080
CMD ["node", "src/server.js"]

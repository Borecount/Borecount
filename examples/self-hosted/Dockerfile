FROM node:22.15.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --omit=dev --ignore-scripts && npm cache clean --force
COPY src src
COPY scripts scripts
COPY deploy deploy
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/index.ts"]

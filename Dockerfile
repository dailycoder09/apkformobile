FROM node:20-slim

WORKDIR /app

# Install server dependencies
COPY server/package*.json ./server/
RUN npm --prefix server install --production

# Install and build React client
COPY client/package*.json ./client/
RUN npm --prefix client install

COPY client/ ./client/
RUN npm --prefix client run build

# Copy server source
COPY server/ ./server/

# Cloud Run sets PORT env var (default 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]

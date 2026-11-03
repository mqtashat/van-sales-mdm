FROM node:22-slim

# Install OpenJDK 17 JRE for official Android apksigner tool execution
RUN apt-get update && \
    apt-get install -y --no-install-recommends openjdk-17-jre-headless ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency descriptors and install production dependencies via clean npm ci
COPY package*.json ./
RUN npm ci --omit=dev

# Copy runtime sources, modules, scripts, and bin binaries (respecting .dockerignore)
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "cloudRunInspectorServer.js"]

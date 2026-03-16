FROM node:20-slim

# Install system deps
RUN apt-get update && apt-get install -y \
  ca-certificates \
  git \
  && rm -rf /var/lib/apt/lists/*

# Install Convex CLI and pnpm globally
RUN npm install -g convex pnpm

# Create app directory
WORKDIR /app

# Copy package.json and install deps
COPY package.json ./
RUN npm install --omit=dev

# Copy app files
COPY index.js ./

# Start worker
CMD ["npm", "start"]
FROM node:20-slim

# Install Python, pip, ffmpeg, curl
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (break-system-packages for Debian 12+)
RUN pip3 install --break-system-packages yt-dlp

# Verify tools are working
RUN yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app

# Install Node deps first (layer cache)
COPY package*.json ./
RUN npm install --production --ignore-scripts

# Copy source
COPY . .

# Create downloads directory
RUN mkdir -p downloads

# Render uses port 10000 by default, but we read from env
EXPOSE 10000

ENV NODE_ENV=production

CMD ["node", "server.js"]

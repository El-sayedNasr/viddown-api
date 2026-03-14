FROM node:20-slim

# Install yt-dlp + ffmpeg
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl ca-certificates \
    && pip3 install -U yt-dlp --break-system-packages \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Update yt-dlp to absolute latest (bot bypass fixes)
RUN yt-dlp -U || true

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]

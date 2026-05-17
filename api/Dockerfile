FROM node:20-slim

# Chromium + libs for Puppeteer PDF rendering. Use the distro Chromium and
# skip Puppeteer's own download to keep the image lean and arch-portable.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3001
CMD ["npm", "run", "dev"]

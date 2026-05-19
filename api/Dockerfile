FROM node:20-slim

# PDF export is client-side (jsPDF in the browser) — no Chromium needed.

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3001
CMD ["npm", "run", "dev"]

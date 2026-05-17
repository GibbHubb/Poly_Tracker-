FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 5173
# Dev server for the first-pass scaffold. Production build is served via nginx
# (see nginx/nginx.conf) once `npm run build` output is wired up.
CMD ["npm", "run", "dev"]

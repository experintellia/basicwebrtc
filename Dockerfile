FROM node:22-slim
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]

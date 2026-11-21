FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

# Ensure cache directory exists and is writable
RUN mkdir -p cache

EXPOSE 7000

ENV PORT=7000
ENV NODE_ENV=production

CMD ["npm", "start"]

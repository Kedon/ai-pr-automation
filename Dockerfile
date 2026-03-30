FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./
RUN npm install

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src

RUN npm run build

EXPOSE 9010

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]

FROM node:20.18.1-alpine

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

EXPOSE 8080

ENTRYPOINT ["yarn", "start"]

FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN mkdir -p output/screenshots output/pdfs output/zips

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
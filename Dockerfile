FROM ghcr.io/puppeteer/puppeteer:22

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY index.js .

USER pptruser

EXPOSE 3000

CMD ["node", "index.js"]

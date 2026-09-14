FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install

COPY src/ src/
COPY lisa.config.yaml ./
RUN npm run build

# Config resolves to /app/lisa.config.yaml; state + artifacts land in /app/.lisa
ENTRYPOINT ["node", "dist/cli.js"]

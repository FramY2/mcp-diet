FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--self-test-server"]

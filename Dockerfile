FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev && chmod +x dist/cli.js && ln -sf /app/dist/cli.js /usr/local/bin/mcp-diet

ENV MCP_DIET_STANDALONE=1
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--self-test-server"]

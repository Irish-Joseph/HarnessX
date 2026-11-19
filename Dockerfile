FROM node:22-bookworm-slim
WORKDIR /workspace
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY apps/vscode-extension/package.json apps/vscode-extension/
RUN npm install
COPY . .
CMD ["npm", "test"]

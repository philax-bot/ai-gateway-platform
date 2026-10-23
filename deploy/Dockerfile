FROM node:22-alpine AS manifests
WORKDIR /app
RUN npm install --global pnpm@11.13.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/web/package.json apps/web/package.json
COPY services/gateway-sim/package.json services/gateway-sim/package.json
COPY services/test-model/package.json services/test-model/package.json
COPY packages/contracts/package.json packages/contracts/package.json
FROM manifests AS dependencies
RUN CI=true pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY apps apps
COPY services services
COPY packages packages
COPY docs/ui-kit/signal-atlas-tokens.css docs/ui-kit/signal-atlas-tokens.css
ARG PUBLIC_ORIGIN=https://localhost:8443
ENV VITE_CONTROL_PLANE_URL=$PUBLIC_ORIGIN VITE_GATEWAY_URL=$PUBLIC_ORIGIN VITE_REVIEW_MODE=false
RUN pnpm -r build

FROM manifests AS production-dependencies
RUN CI=true pnpm --filter @ai-gateway/control-plane... --filter @ai-gateway/gateway-sim... install --prod --frozen-lockfile

FROM node:22-alpine AS server
WORKDIR /app
ENV NODE_ENV=production PLATFORM_MODE=production HOST=0.0.0.0
COPY --from=production-dependencies /app /app
COPY --from=build /app/apps/control-plane/dist apps/control-plane/dist
COPY --from=build /app/apps/control-plane/migrations apps/control-plane/migrations
COPY --from=build /app/services/gateway-sim/dist services/gateway-sim/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
RUN mkdir -p /var/lib/signal-atlas/journal && chown -R node:node /var/lib/signal-atlas
USER node
ENTRYPOINT ["node"]
CMD ["apps/control-plane/dist/main.js"]

FROM nginx:stable-alpine AS web
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8443
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]

FROM server AS operations
USER root
RUN apk add --no-cache postgresql16-client
COPY scripts/backup.mjs scripts/backup.mjs
COPY scripts/lib/backup.mjs scripts/lib/backup.mjs
USER node
CMD ["scripts/backup.mjs", "--help"]

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine

# See backend/Dockerfile: declared in the final stage because an ARG only
# exists in the stage that declares it.
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown

COPY --from=build /app/dist /usr/share/nginx/html

# Written after the COPY so a stale version.json in dist cannot shadow it, and
# generated here rather than by Vite so the static build stays cacheable — the
# SHA changes every commit and would otherwise bust the whole npm build layer.
RUN printf '{"service":"frontend","sha":"%s","builtAt":"%s"}\n' \
      "$BUILD_SHA" "$BUILD_TIME" > /usr/share/nginx/html/version.json

COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]

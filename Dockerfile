# ---- 构建阶段：纯前端静态产物，无后端、无在线服务 ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 托管阶段：nginx 仅提供静态文件 ----
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# WEB_PORT 可在 compose / 运行时覆盖；nginx 启动脚本据此生成监听配置
ENV WEB_PORT=8080
EXPOSE 8080
CMD ["/bin/sh", "-c", "sed \"s/__WEB_PORT__/${WEB_PORT}/g\" /etc/nginx/conf.d/default.conf > /tmp/default.conf && nginx -c /tmp/default.conf"]

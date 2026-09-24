# 博物馆展签排版工具
# 依赖在容器启动时安装（sh -c "npm install && node server.js"），
# 因此镜像只需要基础运行时；也可在启动时通过卷挂载更新代码。
FROM node:20-alpine

WORKDIR /app

# 先拷依赖清单以利用层缓存（node_modules 不打入镜像）
COPY package.json package-lock.json ./

# 复制应用代码
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

# 启动时安装依赖再启动服务（按需求：依赖随启动安装）
CMD ["sh", "-c", "npm install --omit=dev && exec node server.js"]

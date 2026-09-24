// 极简静态服务器：页面逻辑全部在浏览器端完成，无账号、无数据库、无外部服务。
const path = require('path');
const express = require('express');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`展签排版工具已启动: http://localhost:${PORT}`);
});

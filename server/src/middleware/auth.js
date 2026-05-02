// src/middleware/auth.js
// Autenticação simples por API Key para rotas administrativas.
// A dashboard envia o header: x-api-key: <valor do .env>

export function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ erro: 'API key inválida ou ausente' });
  }
  next();
}
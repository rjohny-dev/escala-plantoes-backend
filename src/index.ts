import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import aiRouter from './routes/ai';
import copaRouter from './routes/copa';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);
const APP_SECRET = process.env.APP_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD && !APP_SECRET) {
  console.error('FATAL: APP_SECRET não configurada. Configure a variável de ambiente antes de iniciar em produção.');
  process.exit(1);
}

app.use(helmet());

// App mobile não usa CORS (bypass nativo), mas isso bloqueia scripts de browser
app.use(cors({
  origin: false,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-App-Secret'],
}));

app.use(express.json({ limit: '32kb' }));

// Rate limiting por IP — 120 req / 15 min (proteção contra DoS e brute force)
const ipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
});
app.use('/api/', ipLimiter);

// Autenticação por secret do app
app.use('/api/ai', (req: Request, res: Response, next: NextFunction) => {
  if (!APP_SECRET) return next(); // dev local sem APP_SECRET configurada
  if (req.headers['x-app-secret'] !== APP_SECRET) {
    console.warn(`[SECURITY] Acesso não autorizado — IP: ${req.ip} | path: ${req.path}`);
    res.status(401).json({ error: 'Não autorizado.' });
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/ai/chat', aiRouter);
app.use('/api/copa/schedule', copaRouter);

app.listen(PORT, () => {
  console.log(`✅ EscalaPlantões backend rodando na porta ${PORT}`);
});

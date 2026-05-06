import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import aiRouter from './routes/ai';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/ai/chat', aiRouter);

app.listen(PORT, () => {
  console.log(`✅ EscalaPlantões backend rodando na porta ${PORT}`);
});

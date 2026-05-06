import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { countTodayRequests, getLastRequestTime, recordRequest } from '../db/database';

const router = Router();

const DAILY_LIMIT = 10;
const COOLDOWN_SECONDS = 30;

const SYSTEM_CONTEXT = `Você é um assistente especializado em escala de plantões 3x3 rotativa para trabalhadores do Brasil.

O ciclo de 12 dias funciona assim:
- Dias 1-3: Plantão Diurno (07:00 às 19:00, 12h)
- Dias 4-6: Folga
- Dias 7-9: Plantão Noturno (19:00 às 07:00 do dia seguinte, 12h)
- Dias 10-12: Folga
Depois recomeça do dia 1.

Regras importantes:
- Descanso mínimo de 12h entre qualquer dois turnos consecutivos
- Extras permitidos apenas em dias de folga (respeitando o descanso mínimo)
- Folha de ponto: período do dia 21 do mês anterior ao dia 20 do mês atual
- A data de início do turno define o período — noturno que começa dia 20 entra no período atual
- Tipos: Plantão Diurno, Plantão Noturno, Extra Diurno, Extra Noturno
- Permuta: troca simples entre dois trabalhadores (sem débito)
- Substituição: um faz o plantão pelo outro, cria débito pendente

Responda de forma clara e objetiva em português. Se a pergunta não for sobre escala de trabalho, redirecione gentilmente.`;

router.post('/', async (req: Request, res: Response) => {
  const { question, userId } = req.body as { question?: string; userId?: string };

  if (!question?.trim() || !userId?.trim()) {
    res.status(400).json({ error: 'question e userId são obrigatórios.' });
    return;
  }

  const todayCount = countTodayRequests(userId);
  if (todayCount >= DAILY_LIMIT) {
    res.status(429).json({
      error: `Limite de ${DAILY_LIMIT} perguntas por dia atingido. Tente amanhã.`,
      questionsRemaining: 0,
    });
    return;
  }

  const lastTime = getLastRequestTime(userId);
  if (lastTime !== null) {
    const elapsed = Math.floor(Date.now() / 1000) - lastTime;
    if (elapsed < COOLDOWN_SECONDS) {
      const waitSeconds = COOLDOWN_SECONDS - elapsed;
      res.status(429).json({
        error: `Aguarde ${waitSeconds}s antes de fazer outra pergunta.`,
        waitSeconds,
        questionsRemaining: DAILY_LIMIT - todayCount,
      });
      return;
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
    return;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_CONTEXT,
  });

  const MAX_RETRIES = 3;
  let lastErr: any;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(question.trim());
      const answer = result.response.text();

      recordRequest(userId);
      res.json({ answer, questionsRemaining: DAILY_LIMIT - (todayCount + 1) });
      return;
    } catch (err: any) {
      lastErr = err;
      const is503 = err?.message?.includes('503') || err?.message?.includes('Service Unavailable');
      if (is503 && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      break;
    }
  }

  console.error('Gemini error:', lastErr?.message ?? lastErr);
  res.status(500).json({ error: 'Erro ao consultar a IA. Tente novamente.' });
});

export default router;

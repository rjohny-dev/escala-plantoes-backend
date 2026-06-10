/**
 * backend/src/routes/ai.ts — Rota de IA com streaming SSE e histórico de conversa
 *
 * POST /api/ai/chat
 *
 * Body:
 *   messages:       Array<{ role: 'user' | 'assistant', text: string }>
 *                   Histórico completo da conversa, incluindo a pergunta atual como
 *                   último item (role: 'user'). Máximo recomendado: 12 mensagens.
 *   userId:         string  — ID do dispositivo para controle de limite diário
 *   scheduleContext?: string — Contexto compacto da escala do usuário
 *
 * Resposta: SSE (text/event-stream)
 *   Chunks de texto:   data: {"text":"parte da resposta"}\n\n
 *   Erro durante stream: data: {"error":"mensagem"}\n\n
 *   Fim:               data: [DONE]\n\n
 *
 *   Erros ANTES do stream (rate limit, validação) retornam JSON normal com status 4xx/5xx.
 *
 * Modelos com fallback automático quando quota diária esgota:
 *   gemini-2.5-flash → gemini-2.0-flash → gemini-1.5-flash
 *
 * Importante para Render (Nginx):
 *   Header X-Accel-Buffering: no desativa o buffer do Nginx,
 *   garantindo que os chunks chegam ao cliente imediatamente.
 */

import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { GenerateContentStreamResult, Content } from '@google/generative-ai';
import { countTodayRequests, getLastRequestTime, recordRequest } from '../db/database';

const router = Router();

const DAILY_LIMIT    = 10;
const COOLDOWN_SECONDS = 30;

// Modelos em ordem de preferência — fallback automático quando quota diária esgota
// gemini-2.5-flash: 20 RPD  |  gemini-2.0-flash: 200 RPD  |  gemini-1.5-flash: 1500 RPD
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

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

Quando receber a escala do usuário, use-a para responder perguntas sobre datas específicas diretamente, sem pedir informações adicionais.
Responda de forma clara e objetiva em português. Mantenha as respostas concisas.
Se a pergunta não for sobre escala de trabalho, redirecione gentilmente.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isDailyQuotaExceeded(err: any): boolean {
  const msg: string = err?.message ?? '';
  return msg.includes('429') && (
    msg.includes('PerDay') ||
    msg.includes('per_day') ||
    msg.includes('GenerateRequestsPerDay')
  );
}

function isTransient(err: any): boolean {
  const msg: string = err?.message ?? '';
  return msg.includes('503') ||
    msg.includes('Service Unavailable') ||
    (msg.includes('429') && msg.includes('PerMinute'));
}

// ─── Rota principal ───────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const { messages, userId, scheduleContext } = req.body as {
    messages?: Array<{ role: 'user' | 'assistant'; text: string }>;
    userId?: string;
    scheduleContext?: string;
  };

  // ── Validação ──────────────────────────────────────────────────────────────

  if (!Array.isArray(messages) || messages.length === 0 || !userId?.trim()) {
    res.status(400).json({ error: 'messages (array) e userId são obrigatórios.' });
    return;
  }

  // Bloqueia userIds suspeitos (muito longos ou com caracteres inválidos)
  if (!/^[\w\-]{4,64}$/.test(userId)) {
    res.status(400).json({ error: 'userId inválido.' });
    return;
  }

  // Limita o histórico para evitar payloads gigantes consumindo tokens
  if (messages.length > 20) {
    res.status(400).json({ error: 'Histórico de mensagens muito longo.' });
    return;
  }

  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== 'user' || !lastMsg.text.trim()) {
    res.status(400).json({ error: 'A última mensagem deve ser do usuário e não pode ser vazia.' });
    return;
  }

  // Valida tamanho máximo de cada mensagem e do scheduleContext
  if (messages.some(m => typeof m.text !== 'string' || m.text.length > 4000)) {
    res.status(400).json({ error: 'Mensagem individual muito longa (máx 4000 caracteres).' });
    return;
  }

  if (scheduleContext !== undefined && (typeof scheduleContext !== 'string' || scheduleContext.length > 2000)) {
    res.status(400).json({ error: 'scheduleContext inválido ou muito longo.' });
    return;
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

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

  // ── Montar contexto e histórico no formato do Gemini ──────────────────────

  const systemInstruction = scheduleContext
    ? `${SYSTEM_CONTEXT}\n\n--- ESCALA DO USUÁRIO ---\n${scheduleContext}\n--- FIM DA ESCALA ---`
    : SYSTEM_CONTEXT;

  // Gemini usa 'model' para o papel do assistente, não 'assistant'
  const contents: Content[] = messages.map((msg) => ({
    role: (msg.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
    parts: [{ text: msg.text }],
  }));

  // ── Tentar obter stream do melhor modelo disponível ───────────────────────

  const genAI = new GoogleGenerativeAI(apiKey);
  let streamResult: GenerateContentStreamResult | null = null;
  let successModel = '';
  let lastErr: any;

  for (const modelName of FALLBACK_MODELS) {
    const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });

    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        // generateContentStream rejeita a Promise para erros de quota/auth.
        // Uma vez resolvida, o stream de chunks fica disponível em .stream
        const r = await model.generateContentStream({ contents });
        streamResult  = r;
        successModel  = modelName;
        break;
      } catch (err: any) {
        lastErr = err;

        if (isDailyQuotaExceeded(err)) {
          console.warn(`${modelName}: quota diária esgotada, tentando próximo modelo`);
          break; // Próximo modelo
        }

        if (isTransient(err) && attempt < 6) {
          // Backoff exponencial para erros transitórios (503, 429/min)
          const delay = Math.min(3000 + (attempt - 1) * 2000, 12000);
          await sleep(delay);
          continue;
        }

        break; // Erro não recuperável neste modelo
      }
    }

    if (streamResult) break;
  }

  // Todos os modelos falharam — retorna JSON normal (headers ainda não enviados)
  if (!streamResult) {
    console.error('Todos os modelos falharam:', lastErr?.message ?? lastErr);
    res.status(500).json({ error: 'Serviço de IA temporariamente indisponível. Tente novamente em instantes.' });
    return;
  }

  // ── Iniciar resposta SSE ───────────────────────────────────────────────────

  // Registra a pergunta ANTES de começar o streaming (Gemini já foi chamado)
  recordRequest(userId);
  console.log(`Streaming iniciado com ${successModel} para userId=${userId}`);

  // Headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // X-Accel-Buffering: no → desativa buffer do Nginx no Render,
  // garantindo que cada chunk é enviado ao cliente imediatamente
  res.setHeader('X-Accel-Buffering', 'no');

  // ── Transmitir chunks ──────────────────────────────────────────────────────

  try {
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) {
        // Formato SSE: cada evento é "data: <json>\n\n"
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }
  } catch (err: any) {
    // Erro durante o streaming (raro) — envia evento de erro antes de fechar
    console.error(`Erro durante streaming (${successModel}):`, err?.message ?? err);
    res.write(`data: ${JSON.stringify({ error: 'Resposta interrompida inesperadamente. Tente novamente.' })}\n\n`);
  }

  // Sinaliza fim do stream
  res.write('data: [DONE]\n\n');
  res.end();
});

export default router;

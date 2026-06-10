/**
 * GET /api/copa/schedule
 *
 * Proxy para api-football.com (api-sports) com cache em memória (15 min).
 * Variável de ambiente: FOOTBALL_DATA_TOKEN  (chave api-sports)
 *
 * Copa 2026 → league=1, season=2026
 * Free tier: 100 req/dia — o cache garante uso mínimo (~96 req/dia máximo,
 * na prática muito menos porque o app não abre o calendário 100× por dia).
 */

import { Router, Request, Response } from 'express';

const router = Router();
const API_BASE = 'https://v3.football.api-sports.io';
const LEAGUE_ID = 1;     // FIFA World Cup (fixo na api-sports)
const SEASON    = 2026;

let _cache: { data: TransformedMatch[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

interface TransformedMatch {
  id: number;
  date: string;
  time: string;
  stage: string;
  group?: string;
  status: string;
  team1: string;
  team2: string;
  team1Name: string;
  team2Name: string;
  score1: number | null;
  score2: number | null;
}

router.get('/', async (_req: Request, res: Response) => {
  const token = process.env.FOOTBALL_DATA_TOKEN;

  if (!token) {
    res.json({ matches: [], configured: false });
    return;
  }

  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    res.json({ matches: _cache.data, cached: true });
    return;
  }

  try {
    const response = await fetch(
      `${API_BASE}/fixtures?league=${LEAGUE_ID}&season=${SEASON}`,
      {
        headers: { 'x-apisports-key': token },
        signal: AbortSignal.timeout(12_000),
      }
    );

    if (!response.ok) {
      console.warn(`[Copa] api-sports retornou ${response.status}`);
      if (_cache) { res.json({ matches: _cache.data, cached: true, stale: true }); return; }
      res.status(response.status).json({ error: 'Falha ao buscar agenda da Copa.' });
      return;
    }

    const json = (await response.json()) as { response?: any[]; errors?: any };

    if (json.errors && Object.keys(json.errors).length > 0) {
      console.warn('[Copa] Erros na resposta api-sports:', json.errors);
      if (_cache) { res.json({ matches: _cache.data, cached: true, stale: true }); return; }
      res.status(503).json({ error: 'Erro ao buscar agenda da Copa.' });
      return;
    }

    const matches = transformMatches(json.response ?? []);
    _cache = { data: matches, fetchedAt: now };
    res.json({ matches });
  } catch (err: any) {
    console.error('[Copa] Erro:', err?.message ?? err);
    if (_cache) { res.json({ matches: _cache.data, cached: true, stale: true }); return; }
    res.status(503).json({ error: 'Agenda da Copa temporariamente indisponível.' });
  }
});

function mapStage(round: string): string {
  const r = round.toLowerCase();
  if (r.includes('group'))        return 'GROUP_STAGE';
  if (r.includes('round of 32') || r.includes('last 32')) return 'LAST_32';
  if (r.includes('round of 16') || r.includes('last 16')) return 'LAST_16';
  if (r.includes('quarter'))      return 'QUARTER_FINALS';
  if (r.includes('semi'))         return 'SEMI_FINALS';
  if (r.includes('3rd') || r.includes('third') || r.includes('place')) return 'THIRD_PLACE';
  if (r.includes('final'))        return 'FINAL';
  return round;
}

function transformMatches(raw: any[]): TransformedMatch[] {
  return raw
    .filter((m) => m?.teams?.home && m?.teams?.away)
    .map((m) => {
      // Converte UTC → Brasília (UTC-3)
      const utc  = new Date(m.fixture.date as string);
      const brMs = utc.getTime() - 3 * 60 * 60 * 1000;
      const br   = new Date(brMs);

      const dateStr = br.toISOString().slice(0, 10);
      const timeStr = br.toISOString().slice(11, 16);

      // api-sports usa .teams.home.code (TLA de 3 letras) ou cai no nome
      const tla1 = ((m.teams.home.code as string) ?? '').toUpperCase();
      const tla2 = ((m.teams.away.code as string) ?? '').toUpperCase();

      return {
        id:        m.fixture.id as number,
        date:      dateStr,
        time:      timeStr,
        stage:     mapStage((m.league.round as string) ?? ''),
        group:     (m.league.round as string)?.includes('Group')
                     ? (m.league.round as string).replace('Group Stage - ', 'GROUP_')
                     : undefined,
        status:    (m.fixture.status?.short as string) ?? '',
        team1:     tla1 || m.teams.home.name,
        team2:     tla2 || m.teams.away.name,
        team1Name: (m.teams.home.name as string) ?? '',
        team2Name: (m.teams.away.name as string) ?? '',
        score1:    (m.goals?.home as number | null) ?? null,
        score2:    (m.goals?.away as number | null) ?? null,
      };
    });
}

export default router;

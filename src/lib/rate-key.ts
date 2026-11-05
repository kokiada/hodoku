import type { FastifyRequest } from 'fastify';

/** ログイン中はセッション単位、未ログインはIP単位で回数を数える（同じ回線の別ユーザーを巻き込まない） */
export const rateKey = (req: FastifyRequest): string => req.cookies?.hodoku_session ? `s:${req.cookies.hodoku_session}` : `ip:${req.ip}`;
